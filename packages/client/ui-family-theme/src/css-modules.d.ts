/** CSS Modules are compiled by the Client bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
