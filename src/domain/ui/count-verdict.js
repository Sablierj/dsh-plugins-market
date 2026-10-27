/**
 * D-9 计数判读 —— **domain 层唯一实现**（LLD v1.0 §0.3 强制引用项）。
 *
 * 「未取到」= 0 + 无观测时间；「测出来是 0」= 0 + 有观测时间。一切读取方（工具/页面/
 * 报告）按 observed_at 有没有判读，禁止把默认 0 当测量 0。判读函数只写这一处，
 * 展示层引用不重写（HLD 分层纪律：判据只住 domain）。
 *
 * 挂点：T69 评论四格读数（LLD §1.6）、T70 评分分布/样本量（§2.6）、T71-T73 凡计数 0
 * 的展示格。返回值是**判读词或原值**：非 0 的数原样返回（不把真数包成话）。
 */
export function countVerdict(value, observedAt) {
  const observed = observedAt !== null && observedAt !== undefined && String(observedAt).trim() !== ''
  if (value === null || value === undefined) {
    return observed ? '未取到（不是测量值）' : '未取到（默认 0，不是测量值）'
  }
  if (Number(value) === 0) {
    return observed ? '0（测出来的）' : '未取到（默认 0，不是测量值）'
  }
  return value
}
