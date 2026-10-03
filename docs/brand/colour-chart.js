// Fills in each swatch's hex and each pair's contrast ratio from the rendered styles,
// so the chart always shows what brand.css actually produces.
const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = (h) => {
  const [r, g, b] = h.slice(1).match(/../g).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const panel of document.querySelectorAll('.panel')) {
  const colour = {};
  for (const chip of panel.querySelectorAll('[data-token]')) {
    colour[chip.dataset.token] = hex(getComputedStyle(chip).backgroundColor);
    chip.closest('.swatch').querySelector('.hex').textContent = colour[chip.dataset.token];
  }
  for (const row of panel.querySelectorAll('[data-pair]')) {
    const [fg, bg] = row.dataset.pair.split('/');
    const r = ratio(colour[fg], colour[bg]);
    const ok = r >= Number(row.dataset.min);
    row.querySelector('.ratio').textContent = `${ok ? '✓' : '✕'} ${r.toFixed(2)}:1 (needs ${row.dataset.min}:1)`;
  }
}
