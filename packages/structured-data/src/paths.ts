export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const extname = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
};
