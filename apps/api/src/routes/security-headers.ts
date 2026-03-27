import { Elysia } from "elysia";

export const securityHeaders = new Elysia({ name: "security-headers" }).onAfterHandle(
	({ set }) => {
		set.headers["X-Content-Type-Options"] = "nosniff";
		set.headers["X-Frame-Options"] = "DENY";
		set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
		set.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
	},
);
