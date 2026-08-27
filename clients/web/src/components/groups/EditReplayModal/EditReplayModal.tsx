import { useState } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { JsonEditor } from "../../elements/JsonEditor/JsonEditor";
import { isJsonObject } from "../../../utils/jsonObjectDraft";
import { isSerializableJson } from "@inspector/core/json/jsonUtils.js";

export interface EditReplayModalProps {
  opened: boolean;
  /** The method being replayed, shown so the editor is unambiguous. */
  method: string;
  /** The originating entry's params, seeded into the editor. */
  params?: Record<string, unknown>;
  /**
   * Re-issue the request with these params. `null` means "send no params",
   * which is a request an empty editor can legitimately express — see
   * {@link ReplayParamsOverride} for why it is not `undefined`.
   */
  onSend: (params: Record<string, unknown> | null) => void;
  onClose: () => void;
}

const MethodText = Text.withProps({
  size: "sm",
  c: "dimmed",
  ff: "monospace",
});

const Footer = Group.withProps({ justify: "flex-end", gap: "sm" });

/**
 * What the editor's text currently means: the params to send, or why they
 * cannot be sent.
 *
 * Empty text is "no params" rather than an error — a `tools/list` replay
 * genuinely carries none, and an empty editor wearing a red error would read as
 * broken. A non-object is reported separately from text that is not JSON at
 * all: JSON-RPC `params` must be a structured value, so `42` is a shape that
 * cannot be sent however finished it is. A number that overflows is a third
 * case, and the subtlest — see the note on that branch.
 */
function parseParamsDraft(
  text: string,
):
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON — this cannot be sent" };
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, error: "Params must be a JSON object (`{ … }`)" };
  }
  // `JSON.parse` accepts numeric literals it cannot represent: `1e400` parses to
  // `Infinity`, which `JSON.stringify` then writes as `null`. Accepting it here
  // would show the user one value and send another — the one thing an inspector
  // must not do. Same guard, same reason, as `parseJsonObjectDraft`.
  if (!isSerializableJson(parsed)) {
    return {
      ok: false,
      error:
        "Numbers must be finite — a value like `1e400` overflows and would be sent as null",
    };
  }
  return { ok: true, value: parsed };
}

/**
 * The modal's body, split out so its draft is owned by a component Mantine
 * unmounts on close — which is what makes reopening start from the entry's
 * params again rather than from whatever was last typed and abandoned.
 */
function EditReplayForm({
  method,
  params,
  onSend,
  onClose,
}: Omit<EditReplayModalProps, "opened">) {
  const [draft, setDraft] = useState(() =>
    params === undefined ? "" : JSON.stringify(params, null, 2),
  );
  const parsed = parseParamsDraft(draft);

  return (
    <Stack gap="sm">
      <MethodText>{method}</MethodText>
      <JsonEditor
        ariaLabel="Request params"
        label="Params"
        value={draft}
        onChange={setDraft}
        error={parsed.ok ? undefined : parsed.error}
        minLines={8}
        maxLines={24}
      />
      <Footer>
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          // Unlike the metadata editor, this modal *has* a commit gesture to
          // gate — so invalid text disables Send rather than quietly sending
          // the last value that parsed. Same reasoning as `SchemaJsonField`.
          disabled={!parsed.ok}
          onClick={() => {
            /* v8 ignore next -- Send is disabled while the draft is invalid */
            if (!parsed.ok) return;
            onSend(parsed.value);
            onClose();
          }}
        >
          Send
        </Button>
      </Footer>
    </Stack>
  );
}

/**
 * Edit a Protocol entry's request params, then replay it (#2151).
 *
 * Replay itself is one click and unchanged; this is a second way to *supply*
 * the params, not a second replay implementation — Send dispatches through the
 * same `replayProtocolRequest` the plain Replay button does, so the same
 * method gate and the same "Can't replay" failure toast apply.
 */
export function EditReplayModal({
  opened,
  method,
  params,
  onSend,
  onClose,
}: EditReplayModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Edit and replay" size="lg">
      <EditReplayForm
        method={method}
        params={params}
        onSend={onSend}
        onClose={onClose}
      />
    </Modal>
  );
}
