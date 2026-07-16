
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recover(herdr, paneId, config) {
  if (config.dismissMenu) {
    await herdr.sendKeys(paneId, 'esc');
    await delay(config.menuDismissDelayMs);
  }
  await herdr.sendText(paneId, config.retryMessage);
  await delay(config.submitDelayMs);
  await herdr.sendKeys(paneId, 'enter');
}
