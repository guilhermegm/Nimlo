'use strict';

// Navigate current command popovers and frozen prior releases with the same
// fixture workflows. These helpers contain no application state assertions.
async function menu(page, section='files') {
  const modern=await page.locator('#session-menu').count();
  if (!modern) {
    if (await page.locator('#files-menu').isHidden()) await page.click('#files-toggle');
    const tab=page.locator('#menu-'+section+'-tab');
    if (await tab.isVisible()) await tab.click();
    return;
  }
  const trigger={files:'files-toggle',session:'connection-state',ai:'ai-toggle'}[section];
  if (await page.locator('#'+section+'-menu').isHidden()) await page.click('#'+trigger);
}
async function closeMenu(page) {
  for (const [menuId,closeId] of [['files-menu','menu-close'],['session-menu','session-menu-close'],['ai-menu','ai-menu-close']]) {
    if (await page.locator('#'+menuId).isVisible()) {
      await page.click(await page.locator('#'+closeId).isVisible() ? '#'+closeId : '#files-toggle');
    }
  }
}
async function aiOptions(page) {
  if (await page.locator('#ai-menu').count()) await menu(page,'ai');
}
async function ai(page) {
  if (await page.locator('#mobile-ai').isVisible()) await page.click('#mobile-ai');
  else { await aiOptions(page); await page.click(await page.locator('#ai-show').count() ? '#ai-show' : '#ai-toggle'); }
}
async function closeAi(page) { await aiOptions(page); await page.click('#close-ai'); }
async function code(page) {
  if (await page.locator('#mobile-code').isVisible()) await page.click('#mobile-code');
  else if (await page.locator('#app').getAttribute('data-ai-open')==='yes') await closeAi(page);
}
async function mode(page, value) {
  await aiOptions(page); await page.click('#ai-layout-'+value);
  await page.waitForFunction(value => document.getElementById('app').dataset.aiLayout===value,value);
}
module.exports={menu,closeMenu,aiOptions,ai,closeAi,code,mode};
