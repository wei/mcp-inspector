/**
 * One editable `{ key, value }` row — the in-memory shape the Inspector uses
 * for custom headers, request metadata, and stdio environment variables
 * (`InspectorServerSettings.headers` and friends). A pair *array* rather than
 * a record specifically so a controlled form can hold a half-typed row with a
 * blank key; the persist layer collapses it to a record and drops the blanks.
 *
 * Declared here, in `utils`, because it is a pure domain type shared by a
 * component (`KeyValueRows`, which re-exports it) and non-UI logic
 * (`serverSettingsPatch`). Imports point `components -> utils`, never back.
 */
export interface KeyValuePair {
  key: string;
  value: string;
}
