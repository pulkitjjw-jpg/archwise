// Plain-language, one-line descriptions per component type, for the Simple view toggle.
// Frontend-only presentational data -- doesn't touch what the backend generates or stores.

const TYPE_DESCRIPTIONS: Record<string, string> = {
  cdn: "Speeds up your app by caching content in locations close to your users around the world.",
  compute: "Runs your application's core logic — the code that actually handles user requests.",
  worker: "Processes tasks in the background, like generating reports or resizing images, without making users wait.",
  database: "Stores your app's structured data — things like records, bookings, or accounts — safely and reliably.",
  storage: "Stores files and uploads (images, PDFs, documents) cheaply and durably.",
  queue: "Holds tasks that need to happen soon but don't have to happen instantly, so spikes don't slow the app down.",
  cache: "Keeps frequently-used data close at hand so repeat requests come back almost instantly.",
  auth: "Handles user sign-in, passwords, and who's allowed to access what.",
  lb: "The system's front door — spreads incoming traffic across your running instances and stops sending traffic to any that go unhealthy.",
  dns: "Points your custom domain (like yourapp.com) at the right place, and is the mechanism a future multi-region setup would route through.",
  monitoring: "Watches your running system's logs, metrics, and traces so problems get caught before users report them.",
  notification: "Sends emails, texts, or push alerts out to your users or other systems, separate from the app's own background task queue.",
  tokenization: "Swaps sensitive data (like card numbers) for safe placeholder tokens, so the real data never touches the rest of your systems directly.",
  "audit-log": "Keeps a tamper-proof record of who did what and when — required for compliance reviews.",
  "phi-vault": "A specially secured, separate store for protected health information, locked down beyond your normal data.",
  deidentification: "Automatically strips or masks personal details from records before they're used for anything else, like analytics.",
};

export function getPlainDescription(componentType: string, componentId: string): string {
  if (componentType === "compute" && componentId === "worker") {
    return TYPE_DESCRIPTIONS.worker;
  }
  return TYPE_DESCRIPTIONS[componentType] || "Supports the system as part of the overall architecture.";
}

// "Learn" content -- teaches the underlying concept with a real-world analogy, for the drawer's
// collapsed-by-default Learn toggle (Workstream F). Deliberately generic/conceptual rather than
// project-specific: the "why this exists in YOUR design" tie-in already lives in the component's
// own `reasoning` field (surfaced via info tooltips elsewhere) -- this teaches the concept itself,
// which doesn't change from one project to the next.
type LearnContent = { analogy: string; deeper: string };

const LEARN_CONTENT: Record<string, LearnContent> = {
  cdn: {
    analogy:
      "Like stocking copies of a popular book in libraries all over the country instead of one central library everyone has to travel to.",
    deeper:
      "Whoever's closest gets served fastest, and the original server (the \"central library\") doesn't get overwhelmed by every single request. This matters most for static content — images, videos, scripts — that doesn't change per user.",
  },
  compute: {
    analogy: "The kitchen of your application — where the actual cooking (processing) happens.",
    deeper:
      "An order (request) comes in, gets prepared using your business logic, and a finished dish (response) goes back out. How many \"kitchens\" you run, and whether they scale up automatically during a rush, is exactly what the LLD config below controls.",
  },
  worker: {
    analogy:
      "A kitchen's prep cook working in the back — chopping vegetables ahead of time so the line cooks can serve customers fast.",
    deeper:
      "Customers never see or wait on that prep work. In software terms: slow or bulky tasks (sending emails, resizing images, generating reports) get done in the background instead of making a user's request hang while it happens.",
  },
  database: {
    analogy:
      "A filing cabinet with strict rules: every drawer is labeled, nothing gets lost, and two people can't scribble on the same form at once.",
    deeper:
      "Unlike a pile of papers on a desk, you can always find exactly what you're looking for, and the system enforces that data stays consistent even when many people are reading and writing at the same time.",
  },
  storage: {
    analogy: "A self-storage unit for your app: cheap, holds a lot, and you don't open it every five minutes.",
    deeper:
      "Good for files you need to keep — uploads, documents, backups — but don't need to query or search through the way you would rows in a database.",
  },
  queue: {
    analogy: "A deli counter's take-a-number system.",
    deeper:
      "When it's busy, customers don't need to be served instantly — they wait their turn in order, and the counter keeps working through the line at a sustainable pace instead of everyone shouting at once and the staff getting overwhelmed.",
  },
  cache: {
    analogy: "Keeping your most-used tools on your desk instead of walking to a supply closet every time.",
    deeper:
      "It's faster because the data is already close at hand, at the cost of the \"desk\" having limited space — so only the most frequently-needed data stays cached, and it can go stale if the original changes.",
  },
  auth: {
    analogy: "The bouncer-and-wristband system at a venue.",
    deeper:
      "Your ID gets checked once at the door (sign-in), then you get a wristband (session/token) that proves who you are for the rest of the night — so you're not re-checked at every single room.",
  },
  lb: {
    analogy: "A host at a busy restaurant seating guests at whichever table is actually free.",
    deeper:
      "Instead of every customer walking straight to one specific table (server), the host checks which tables are open and healthy, and sends each new party to one that can actually serve them right now — so no single table gets overwhelmed while others sit empty.",
  },
  dns: {
    analogy: "A phone book that turns a business's name into its actual street address.",
    deeper:
      "People type a memorable name (yourapp.com) instead of a numeric address, and the phone book (DNS) looks up where to actually send them. If a business ever opens a second location, the phone book is also exactly where you'd update the listing to send people to the right one.",
  },
  monitoring: {
    analogy: "A car's dashboard — speedometer, fuel gauge, and warning lights, all in one place.",
    deeper:
      "You don't watch it every second, but the moment something's wrong (overheating, low fuel) it tells you before you're stranded on the highway. In software terms: logs, metrics, and traces mean a failing dependency or a creeping slowdown gets caught by an alert, not by a user's angry email.",
  },
  notification: {
    analogy: "A town crier who announces news to everyone who's signed up to hear it, versus a private courier delivering one specific package.",
    deeper:
      "This is different from a task queue (which quietly processes work behind the scenes) — a notification is meant to actually reach a person, over email, text, or a push alert, and it needs to handle the real world's messiness: a bounced email, a bad phone number, a retry, or a fallback plan when delivery fails.",
  },
  tokenization: {
    analogy: "Casino chips — you exchange real cash for chips at the door, and the casino floor never touches your cash directly.",
    deeper:
      "If the chips are lost or stolen, no real money was ever exposed. The same idea applies to sensitive data like card numbers: a token stands in for the real value everywhere except the one vault that can reverse it.",
  },
  "audit-log": {
    analogy: "A building's security camera footage log.",
    deeper:
      "Nobody watches it live all the time, but if something goes wrong, there's an unchangeable record of exactly who did what and when — which is often a legal requirement, not just a nice-to-have.",
  },
  "phi-vault": {
    analogy: "A hospital's locked records room, separate from the general office filing cabinets.",
    deeper:
      "Same building, but extra locks, extra sign-in sheets, and far fewer people allowed in — because the consequences of a leak here are much more serious than for ordinary business data.",
  },
  deidentification: {
    analogy: "A researcher redacting names and addresses from documents before handing them to a study.",
    deeper:
      "The useful patterns (trends, aggregates) remain usable, but nobody can trace a specific result back to a specific person — which is what lets that data be used for analytics without the same strict handling rules as the original.",
  },
};

export function getLearnContent(componentType: string, componentId: string): LearnContent | undefined {
  if (componentType === "compute" && componentId === "worker") {
    return LEARN_CONTENT.worker;
  }
  return LEARN_CONTENT[componentType];
}
