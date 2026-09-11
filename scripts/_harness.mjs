export function watchPipelineError(page) {
  const failed = page.waitForFunction(() => {
    const overlay = document.querySelector('#error-overlay');
    return overlay && !overlay.hidden && !overlay.classList.contains('hidden');
  }, null, { timeout: 0 }).then(async () => {
    const text = await page.evaluate(() => document.querySelector('#error-message')?.textContent ?? 'pipeline error');
    throw new Error(`PIPELINE ERROR: ${String(text).replace(/\s+/g, ' ').slice(0, 400)}`);
  });
  failed.catch(() => {});
  return failed;
}

export async function bootOrFail(page, timeout = 300000) {
  const failed = watchPipelineError(page);
  await Promise.race([failed, page.waitForFunction(
    () => window.__audit && document.querySelector('#loading-overlay')?.hidden, null, { timeout },
  )]);
  return failed;
}
