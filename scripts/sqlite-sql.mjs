export function sqlText(value) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error('SQLite text에는 NUL 문자를 사용할 수 없습니다.');
  }
  return `'${text.replaceAll("'", "''")}'`;
}
