import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Enable Pi's built-in grep tool alongside the default active tools. */
export default function enableGrepExtension(pi: ExtensionAPI) {
	const enableGrep = () => {
		const current = pi.getActiveTools();
		if (!current.includes("grep")) {
			pi.setActiveTools([...current, "grep"]);
		}
	};

	pi.on("session_start", enableGrep);
}
