export function signedUrlExpiresAt(url) {
  try {
    const params = new URL(url).searchParams;
    const date = params.get('X-Tos-Date');
    const seconds = params.get('X-Tos-Expires');
    if (!/^\d{8}T\d{6}Z$/.test(date ?? '') || !/^\d+$/.test(seconds ?? '')) return null;
    const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expiresAt = start + Number(seconds) * 1000;
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch { return null; }
}

export class ResultExpiredError extends Error {
  constructor() {
    super('The video download link expired and the provider could not supply a working replacement. Please generate the video again.');
    this.name = 'ResultExpiredError';
    this.resultExpired = true;
  }
}

export async function downloadTaskResult({ record, download, refresh, saveUrl, now = Date.now }) {
  const originalUrl = record.outcome.videoUrl;
  const isExpired = (url) => {
    const expiry = signedUrlExpiresAt(url);
    return expiry !== null && expiry <= now();
  };
  let expired = isExpired(originalUrl);
  let downloadError;
  if (!expired) {
    try { return await download(originalUrl); }
    catch (err) {
      if (!refresh || ![401, 403, 404, 410].includes(err.status)) throw err;
      downloadError = err;
      expired = Boolean(err.resultExpired) || isExpired(originalUrl);
    }
  }
  if (!refresh || !record.taskId) {
    if (expired) throw new ResultExpiredError();
    throw new Error('Could not refresh the video download link.');
  }

  let fresh;
  try { fresh = await refresh(record.taskId); }
  catch (err) {
    if (expired && (err.status === 404 || err.status === 410)) throw new ResultExpiredError();
    throw err;
  }
  if (!fresh?.videoUrl) throw new Error('The provider did not return a refreshed video URL.');
  if (isExpired(fresh.videoUrl) || (expired && fresh.videoUrl === originalUrl)) throw new ResultExpiredError();
  if (fresh.videoUrl === originalUrl && downloadError) throw downloadError;
  if (fresh.videoUrl !== originalUrl) await saveUrl(fresh.videoUrl);
  try { return await download(fresh.videoUrl); }
  catch (err) {
    if (err.resultExpired || isExpired(fresh.videoUrl)) throw new ResultExpiredError();
    throw err;
  }
}
