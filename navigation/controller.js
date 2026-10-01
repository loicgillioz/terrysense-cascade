/*
 * Navigation — the navigation row of shared/nav.js on its own, for a view with
 * no terrySense widget to carry it: the station view of a station dashboard.
 * Widget: logr-product-docs/cloud/FRONTEND.md *Navigation*.
 *
 * `opts`: as shared/nav.js.
 *
 * Loads after shared/resolver.js, glossary.js, ui.js, tb_io.js and nav.js.
 */

window.TerrySenseNavigation = function (ctx, container, opts) {

var tb = window.TerrySenseTbIo(ctx);
var root = container.querySelector('.ts-root') || container;
var ui = window.TerrySenseUi(root);

root.innerHTML = '';
var card = root.appendChild(ui.h('<div class="ts-card ts-nav-only"></div>'));
window.TerrySenseNav(ctx, tb, ui, card, opts);

};
