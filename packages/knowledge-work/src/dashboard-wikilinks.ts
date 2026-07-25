import { basename } from "node:path";
import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { renderObsidianWikiLinks } from "./utils.ts";

export function rewriteAssistantMessage(
	message: MessageEndEvent["message"],
	vaultName: string,
): MessageEndEvent["message"] | undefined {
	if (message.role !== "assistant") return;
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const text = renderObsidianWikiLinks(block.text, vaultName);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...message, content } : undefined;
}

export default function dashboardWikilinks(pi: ExtensionAPI): void {
	const vaultPath = process.env.PI_KNOWLEDGE_VAULT?.trim() || process.cwd();
	const vaultName = process.env.PI_KNOWLEDGE_VAULT_NAME?.trim() || basename(vaultPath);

	pi.on("message_end", (event) => {
		const message = rewriteAssistantMessage(event.message, vaultName);
		return message ? { message } : undefined;
	});
}
