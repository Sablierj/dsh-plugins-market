/** 时间工具：全库统一用带 Z 的 ISO 字符串存时刻，SQLite 里按字典序即按时间序。 */
export function nowIso() {
  return new Date().toISOString()
}
