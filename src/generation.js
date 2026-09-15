export function createJobRunner({ store, delivery, providers, uploadLimit, showStatus, makeErrorOutcome, pollMs, now = Date.now, logger = console }) {
  async function deferRetry(record, err, stage, outcome) {
    let current = record;
    try { current = await store.get(record.jobId) ?? record; }
    catch (readError) { logger.error(`Could not read retry state for ${record.jobId}: ${readError.message}`); }
    const failures = (current.retry?.failures ?? 0) + 1;
    const delayMs = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 5));
    current = {
      ...current,
      retry: { failures, nextAttemptAt: now() + delayMs, stage, status: err.status ?? null },
    };
    // If the delivery manager's initial save failed, retain the unprepared
    // outcome separately so the next attempt can still assign its identity.
    if (!current.outcome && outcome) current.pendingOutcome = outcome;
    try { await store.save(current); }
    catch (saveError) { logger.error(`Could not save retry state for ${record.jobId}: ${saveError.message}`); }
    logger.warn(`${stage} pending for ${record.taskId || record.jobId}: ${err.message}${err.status ? ` [HTTP ${err.status}]` : ''}; retry in ${delayMs / 60_000}m (attempt ${failures}).`);
    return current;
  }

  async function deliverOutcome(record, outcome, channel) {
    let receipt;
    try {
      receipt = await delivery.deliver(record, outcome, channel);
    } catch (err) {
      const current = await deferRetry(record, err.cause ?? err, 'Delivery', outcome);
      await showStatus(current, channel, 'pending');
      return false;
    }
    // Cosmetic edits and cleanup cannot turn a confirmed delivery into a
    // failed generation or trigger another result message.
    try { await showStatus(receipt, channel, 'delivered'); }
    catch (err) { logger.error(`Status edit pending for ${receipt.jobId}:`, err); }
    await store.remove(receipt.jobId).catch((err) => logger.error(`Receipt cleanup pending for ${receipt.jobId}:`, err));
    const result = receipt.outcome.unavailableContent ? 'expired-result notice' : receipt.outcome.type;
    logger.log(`${receipt.taskId || receipt.jobId}: ${result} delivered as ${receipt.deliveryMessageId}`);
    return true;
  }

  async function processRecord(record, channel) {
    if (!record.delivered && record.retry?.nextAttemptAt > now()) return false;
    if (record.outcome || record.pendingOutcome || record.delivered) return deliverOutcome(record, record.outcome ?? record.pendingOutcome, channel);
    await showStatus(record, channel, 'generating');
    let outcome;
    try {
      // A recovered task can finish while the bot is offline. Even after its
      // deadline it gets one status check before being classified as timed out.
      const remaining = Math.max(1, (record.deadlineAt ?? now()) - now());
      const { videoUrl } = await providers[record.kind].client.waitForTask(record.taskId, { intervalMs: pollMs, timeoutMs: remaining });
      outcome = {
        type: 'video', videoUrl, uploadLimit: uploadLimit(channel?.guild),
        content: `<@${record.userId}>${record.multiIndex ? ` ${record.multiIndex}/${record.multiTotal}` : ''}`,
      };
    } catch (err) {
      if (!err.timedOut && !err.blocked && !err.terminal) {
        await deferRetry(record, err, 'Status check');
        return false;
      }
      logger.error(`Generation ${record.taskId}: ${err.message}`);
      outcome = makeErrorOutcome(record, err);
    }
    return deliverOutcome(record, outcome, channel);
  }

  return { deliverOutcome, processRecord };
}
