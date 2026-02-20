import index from "./index.html";

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3001),
	routes: {
		"/": index,
	},
	development: {
		hmr: true,
		console: true,
	},
});

console.log(`Dashboard listening on ${server.url}`);
