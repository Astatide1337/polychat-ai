declare module "get-browser-path" {
  function getBrowserPath(browser: "Chrome" | "Edg"): string | null;
  export default getBrowserPath;
}
