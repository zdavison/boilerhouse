const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch(_req) {
		return new Response("boilerhouse");
	},
});

console.log(`Boilerhouse API listening on ${server.url}`);
