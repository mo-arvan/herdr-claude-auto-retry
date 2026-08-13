
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recover(herdr, paneId, config, { blocked = false } = {}) {
  if (config.dismissMenu && blocked) {
    await herdr.sendKeys(paneId, 'esc');
    await delay(config.menuDismissDelayMs);
  }
  await herdr.sendText(paneId, config.retryMessage);
  await delay(config.submitDelayMs);
  await herdr.sendKeys(paneId, 'enter');
}
