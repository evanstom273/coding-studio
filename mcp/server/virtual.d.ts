declare module 'virtual:editor-assets' {
  /** Built editor files: published path → base64 content. */
  const assets: Record<string, string>;
  export default assets;
}
