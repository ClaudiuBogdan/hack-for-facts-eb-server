export { startServer } from "./server";
// Start if executed directly
if (require.main === module) {
	require("./server").startServer();
}
