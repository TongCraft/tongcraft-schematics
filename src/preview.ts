export interface PreviewColumn {
  x: number;
  z: number;
  height: number;
  id: string;
}

function color(id: string): [string, string, string] {
  const name = id.split(":")[1] ?? id;
  if (/(?:leaves|grass|moss|vine|sapling|cactus)/.test(name))
    return ["#85ad70", "#5d8b56", "#477449"];
  if (/(?:water|ice|prismarine)/.test(name))
    return ["#85bad3", "#5c91b0", "#407592"];
  if (/(?:log|planks|wood|fence|door|chest)/.test(name))
    return ["#c6a477", "#9a784f", "#7d603e"];
  if (/(?:brick|terracotta|copper)/.test(name))
    return ["#c88e77", "#a96c59", "#895444"];
  if (/(?:glass|quartz|snow|wool|concrete)/.test(name))
    return ["#d8d9d0", "#b6bbb6", "#999e9b"];
  return ["#b7bbb5", "#909994", "#747f7a"];
}

/** A compact, texture-free shape preview. One column represents a sampled X/Z cell. */
export function makePreviewSvg(
  columns: PreviewColumn[],
  minY: number,
  maxY: number,
): string {
  const prefix =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240" role="img">' +
    '<rect width="360" height="240" fill="#f5f5f2"/>';
  if (columns.length === 0)
    return (
      prefix +
      '<text x="180" y="125" text-anchor="middle" fill="#777" font-size="13" font-family="sans-serif">无可见方块</text></svg>'
    );

  const ordered = [...columns].sort(
    (a, b) => a.x + a.z - (b.x + b.z) || a.height - b.height,
  );
  const parts: string[] = [];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const column of ordered) {
    const level = Math.max(
      1,
      Math.round(((column.height - minY + 1) / (maxY - minY + 1)) * 16),
    );
    const x = (column.x - column.z) * 8;
    const base = (column.x + column.z) * 4 + 12;
    const y = base - level * 4;
    const [light, medium, dark] = color(column.id);
    left = Math.min(left, x);
    right = Math.max(right, x + 16);
    top = Math.min(top, y - 4);
    bottom = Math.max(bottom, base + 4);
    parts.push(
      `<path fill="${dark}" d="M${x + 8} ${y + 4}l8 -4v${base - y}l-8 4z"/>` +
        `<path fill="${medium}" d="M${x} ${y}l8 4v${base - y}l-8 -4z"/>` +
        `<path fill="${light}" d="M${x} ${y}l8 -4 8 4 -8 4z"/>`,
    );
  }
  const scale = Math.min(1.35, 320 / (right - left), 190 / (bottom - top));
  const tx = 180 - ((left + right) / 2) * scale;
  const ty = 120 - ((top + bottom) / 2) * scale;
  return (
    prefix +
    `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(3)})">` +
    parts.join("") +
    "</g></svg>"
  );
}
