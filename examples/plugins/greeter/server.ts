import { NotFound, type ServerPlugin } from "@pipoca/plugins";

export default {
  name: "greeter",
  register: (context) => {
    context.routes.handle((_request, path) => {
      if (path !== "greeting") {
        throw new NotFound(`the greeter has no ${path}`);
      }

      return Response.json({ greeting: context.settings.get()["greeting"] });
    });
  },
} satisfies ServerPlugin;
