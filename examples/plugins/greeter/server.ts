export default {
  name: "greeter",
  register: (context) => {
    context.routes.handle(async () =>
      Response.json({ greeting: context.settings.get().greeting }),
    );
  },
};
