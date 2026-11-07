import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord } from "../util";
import { ircRenderer } from "./irc";
import { jobRenderer } from "./job";

/** Message results (including legacy null timeouts) render as IRC; otherwise show jobs. */
function Summary(props: ToolRenderProps): ReactNode {
	return detailsRecord(props.result)?.waited !== undefined ? (
		<ircRenderer.Summary {...props} args={{ op: "wait" }} />
	) : (
		<jobRenderer.Summary {...props} args={{ poll: [] }} />
	);
}

function Body(props: ToolRenderProps): ReactNode {
	return detailsRecord(props.result)?.waited !== undefined ? (
		ircRenderer.Body ? (
			<ircRenderer.Body {...props} args={{ op: "wait" }} />
		) : null
	) : jobRenderer.Body ? (
		<jobRenderer.Body {...props} args={{ poll: [] }} />
	) : null;
}

export const waitRenderer: ToolRenderer = { Summary, Body };
