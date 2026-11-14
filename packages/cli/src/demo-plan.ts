import type { Engine } from "@vigile/core";

/**
 * A made-up plan, for pictures and for tests that need something that looks like real work: relaunching a
 * shop's website, with a mobile app waiting for it. It has groups, dependencies inside and between them, a bug,
 * an incident, and tasks in most states. Returns the IDs of the items the callers refer to.
 */
export async function seedDemoPlan(engine: Engine): Promise<{ checkout: string; cart: string; payment: string; search: string; accounts: string; launch: string }> {
  const as = (user: string) => (operation: string, input: Record<string, unknown>) => engine.execute(operation, user, input) as Promise<any>;
  const admin = as("admin");
  const agent1 = as("agent1");
  const task = async (title: string, description: string, extra: Record<string, unknown> = {}): Promise<string> => (await agent1("create_task", { title, description, ...extra })).id;
  const move = async (id: string, user: string, ...statuses: string[]) => {
    let { version } = await agent1("get", { id });
    for (const status of statuses) version = (await as(user)("set_task_status", { id, version, status })).version;
  };

  await admin("create_user", { username: "agent2", type: "agent" });
  await agent1("create_project", { title: "Website relaunch", prefix: "WEB", description: "Move the shop to the new platform." });
  await agent1("create_project", { title: "Mobile app", prefix: "APP", description: "A first app for returning customers." });

  const checkout = await task("Checkout: a customer can pay for a basket", "Cart, payment and confirmation. Done when a test order goes through from basket to email.", {
    project: "WEB",
    priority: 8,
    why: "Orders are taken by email today, and half of them are abandoned before they are paid.",
  });
  const cart = await task("Cart page lists the items and the total", "Done when items can be added and removed and the total is right.", { project: "WEB", parent: checkout });
  const payment = await task("Payment form takes a card", "Collect the card details and charge the total. Done when a test card is charged and a declined card says why.", {
    project: "WEB",
    parent: checkout,
    depends_on: [cart],
    priority: 8,
    why: "Without it nothing can be sold. It is also where most customers gave up on the old site.",
  });
  await task("Confirmation email is sent after payment", "Done when the email arrives with the order number.", { project: "WEB", parent: checkout, depends_on: [payment] });
  await task("Total is wrong when a coupon is applied twice", "Applying the same coupon twice takes the discount off twice. Done when the second attempt is refused.", {
    project: "WEB",
    parent: checkout,
    type: "bug",
    priority: 9,
    why: "It would give away money on every order from launch day.",
  });

  const search = await task("Search: products are found by name and category", "Done when the ten most searched words give the right products.", { project: "WEB", priority: 6 });
  const index = await task("Index all products every night", "Done when a new product is found the next morning.", { project: "WEB", parent: search });
  const box = await task("Search box with suggestions in the header", "Done when typing three letters shows suggestions.", { project: "WEB", parent: search, depends_on: [index] });
  await task("Filters for price and category", "Done when results can be narrowed by both.", { project: "WEB", parent: search, depends_on: [index] });

  const accounts = await task("Accounts: customers sign in with their old password", "Done when every customer of the old shop can sign in.", { project: "WEB", priority: 5 });
  const importing = await task("Import customer accounts from the old shop", "Done when the count matches the old database.", { project: "WEB", parent: accounts });
  await task("Password reset by email", "Done when a reset link arrives and works once.", { project: "WEB", parent: accounts, depends_on: [importing] });

  const launch = await task("Launch: the domain points to the new site", "Done when the old site is switched off and orders arrive on the new one.", {
    project: "WEB",
    depends_on: [checkout, search, accounts],
    priority: 9,
    why: "Everything else is preparation for this day.",
  });
  const staging = await task("Staging site is down after the last deploy", "The staging site answers 502 since this morning. Done when it is up and the cause is written down.", {
    project: "WEB",
    type: "incident",
    priority: 10,
  });

  const icon = await task("App icon and store listing", "Done when the listing is approved.", { project: "APP" });
  await task("Home screen shows the latest orders", "Done when the three latest orders are listed with their state.", { project: "APP", priority: 4 });
  await task("Push notification when an order ships", "Done when a test order sends one.", { project: "APP", depends_on: ["WEB"] });

  await move(cart, "agent1", "in_progress", "done");
  await move(index, "agent2", "in_progress", "done");
  await move(icon, "agent2", "in_progress", "done");
  await move(checkout, "agent1", "in_progress");
  await move(payment, "agent1", "in_progress");
  await move(search, "agent2", "in_progress");
  await move(box, "agent2", "in_progress", "in_review");
  await move(accounts, "agent2", "in_progress");
  await move(importing, "agent2", "in_progress");
  await move(staging, "agent1", "in_progress");

  return { checkout, cart, payment, search, accounts, launch };
}
