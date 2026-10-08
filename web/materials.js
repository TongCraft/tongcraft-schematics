let namesPromise;

export function loadBlockNames() {
  namesPromise ??= fetch("/assets/block-names.zh-CN.json")
    .then(async (response) => {
      if (!response.ok) throw new Error("中文方块名称加载失败，请刷新重试");
      const data = await response.json();
      return data.names;
    })
    .catch((error) => {
      namesPromise = undefined;
      throw error;
    });
  return namesPromise;
}

export function materialName(id, names) {
  return names[id] ?? "名称未收录";
}

export function materialsCsv(materials, names) {
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [["方块名称", "方块 ID", "数量", "组数(64)", "余数"]];
  for (const { id, count } of materials)
    rows.push([
      materialName(id, names),
      id,
      count,
      Math.floor(count / 64),
      count % 64,
    ]);
  return (
    "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
