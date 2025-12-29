function escapePdfText(text: string): string {
  return text.replace(/[()\\]/g, (match) => `\\${match}`)
}

export function buildMinimalPdf(text: string): Uint8Array {
  const header = '%PDF-1.4\n'
  const escaped = escapePdfText(text)
  const content = `BT /F1 18 Tf 72 120 Td (${escaped}) Tj ET`

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]

  const offsets: number[] = [0]
  let offset = header.length
  for (const obj of objects) {
    offsets.push(offset)
    offset += obj.length
  }

  const xrefOffset = offset
  const xrefEntries = offsets
    .map((entryOffset, index) =>
      index === 0 ? '0000000000 65535 f \n' : `${String(entryOffset).padStart(10, '0')} 00000 n \n`
    )
    .join('')
  const xref = `xref\n0 ${objects.length + 1}\n${xrefEntries}`
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  const pdf = `${header}${objects.join('')}${xref}${trailer}`
  return new TextEncoder().encode(pdf)
}
