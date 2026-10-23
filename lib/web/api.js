/**
 * /kb/api 路由分发（最小骨架；Task 5 补只读路由、Task 6 补写路由）。
 */
import { sendError } from "./http.js";

export async function handleApi(req, res) {
  return sendError(res, 404, "NOT_FOUND", "not implemented");
}
