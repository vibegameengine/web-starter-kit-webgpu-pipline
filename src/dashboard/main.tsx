/** Entry for dashboard.html. Dev-only: the production build ships index.html. */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./dashboard.css";

const host = document.getElementById("root");
if (!host) throw new Error("dashboard: #root missing");

// Deliberately not StrictMode: its double-mount fires the feed poll twice on
// every mount, which doubles the request rate against a file agents are writing
// to and makes the network tab useless for telling whether polling works.
createRoot(host).render(<App />);
