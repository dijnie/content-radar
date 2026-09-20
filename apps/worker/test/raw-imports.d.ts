// Vite `?raw` imports used to load recorded fixtures as strings.
declare module "*?raw" {
  const content: string;
  export default content;
}
