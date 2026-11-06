#!/usr/bin/env python
"""拼多多工作台的 xlsx 工具（Node 侧通过子进程调用）。

命令：
  read-orders <xlsx> <out.json>              读闲鱼订单导出，输出 [{表头: 值}]
  write-orders <out.xlsx> <in.json>          写订单表（带列宽、文本格式）
  write-shipping <template.xlsx> <out.xlsx> <in.json>
                                             以闲鱼批量发货模板为底，填 订单编号/物流公司/快递单号
  carriers <template.xlsx> <out.json>        读模板里的「物流公司」清单
"""
import json
import sys
from pathlib import Path

from openpyxl import load_workbook, Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


def read_orders(src, out):
    wb = load_workbook(src, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        Path(out).write_text('[]', encoding='utf-8')
        return
    header = [('' if c is None else str(c).strip()) for c in rows[0]]
    records = []
    for row in rows[1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue
        item = {}
        for i, name in enumerate(header):
            if not name:
                continue
            value = row[i] if i < len(row) else None
            item[name] = '' if value is None else str(value).strip()
        records.append(item)
    Path(out).write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')


TEXT_COLUMNS = {'物流单号', '收货人手机号', '订单号', '收件号码', '订单编号', '快递单号', '发货单号'}


def write_orders(dest, payload_path):
    payload = json.loads(Path(payload_path).read_text(encoding='utf-8'))
    columns = payload['columns']
    rows = payload['rows']
    widths = payload.get('widths') or {}

    wb = Workbook()
    ws = wb.active
    ws.title = payload.get('sheet') or '订单'
    head_fill = PatternFill('solid', fgColor='F2F2F2')
    for col, name in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col, value=name)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal='center', vertical='center')
        ws.column_dimensions[get_column_letter(col)].width = widths.get(name) or max(10, min(40, len(str(name)) * 2 + 4))
    ws.freeze_panes = 'A2'

    for r, row in enumerate(rows, start=2):
        for c, name in enumerate(columns, start=1):
            value = row.get(name, '')
            cell = ws.cell(row=r, column=c, value=value)
            if name in TEXT_COLUMNS:
                cell.number_format = '@'
            cell.alignment = Alignment(vertical='top', wrap_text=False)
    wb.save(dest)


def write_shipping(template, dest, payload_path):
    payload = json.loads(Path(payload_path).read_text(encoding='utf-8'))
    rows = payload['rows']
    keep = payload.get('keepExamples', 0)
    wb = load_workbook(template)
    ws = wb['发货模板']
    # 模板前 4 行是示例 + 说明，清掉示例行（保留表头）
    for r in range(2, ws.max_row + 1):
        for c in range(1, 6):
            ws.cell(row=r, column=c).value = None
    for i, row in enumerate(rows, start=2):
        ws.cell(row=i, column=1, value=row['orderSn']).number_format = '@'
        ws.cell(row=i, column=2, value=row['carrier'])
        ws.cell(row=i, column=3, value=row['tracking']).number_format = '@'
    wb.save(dest)


def carriers(template, out):
    wb = load_workbook(template)
    ws = wb['物流公司']
    items = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row and row[0]:
            items.append({'name': str(row[0]).strip(), 'short': '' if row[1] is None else str(row[1]).strip()})
    wb.close()
    Path(out).write_text(json.dumps(items, ensure_ascii=False), encoding='utf-8')


def main():
    cmd = sys.argv[1]
    if cmd == 'read-orders':
        read_orders(sys.argv[2], sys.argv[3])
    elif cmd == 'write-orders':
        write_orders(sys.argv[2], sys.argv[3])
    elif cmd == 'write-shipping':
        write_shipping(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'carriers':
        carriers(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(f'unknown command: {cmd}')


if __name__ == '__main__':
    main()
