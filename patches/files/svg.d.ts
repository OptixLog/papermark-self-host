// No *.svg module declaration ships in the public papermark repo; two files
// import papermark-logo.svg and fail the typecheck without it.
declare module "*.svg" {
  const content: any;
  export default content;
}
