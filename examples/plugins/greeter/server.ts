import type { ServerPlugin } from "@pipoca/plugins";

export default {
  name: "greeter",
  register: (context) => {
    context.routes.handle(() =>
      Response.json({ greeting: context.settings.get()["greeting"] }),
    );
  },
} satisfies ServerPlugin;
