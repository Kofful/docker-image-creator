import { AuthError } from "./session";

export function authMessage(
  error: unknown,
  action: "login" | "register" | "account" | "logout",
): string {
  const status = error instanceof AuthError ? error.status : 0;
  if (status === 429)
    return "Too many attempts. Please wait a minute and try again.";
  if (status === 403)
    return "This site is not allowed to access the API. Check the trusted origin setting.";
  if (status === 409 && action === "register")
    return "An account with this email already exists. Please log in.";
  if (status === 401)
    return action === "login"
      ? "Invalid email or password."
      : "Your session has ended. Please log in again.";
  if (status === 400)
    return "Check your email and password. Passwords must be 12–128 characters.";
  if (action === "logout")
    return "Could not confirm logout. Check your connection and try again.";
  return "Unable to reach the API. Please try again.";
}
