/* ==========================================================================
   What an import file may contain, stated once.
   ==========================================================================
   The report: a 46-row Licensee file failed every row with "po prefix is
   required and was blank", and — fairly — "for Licensee there is no PO
   Prefix… advise the date format, please mention somewhere for a user guide,
   so that all users know how to put order info for upload."

   Three separate faults behind that, and the third is the one that would
   have caused real damage:

     1. PO PREFIX WAS REQUIRED FOR LICENSEE. It should never have been. A
        Perry Ellis PO is `RT` + `5077`; a licensee's is a single reference
        like `TP13-SP27 HATS` with no prefix at all. The requirement was
        copied from the Main PLM rules without asking whether it applied.

     2. THE FIELD RULES LIVED ONLY IN CODE. There was nowhere for somebody
        filling in a spreadsheet to find out what was required or what a date
        should look like. This file is that list, and the screen, the
        downloadable template and the importer all read it — so the guide
        cannot drift from what the code actually enforces.

     3. DATES WERE GUESSED. `new Date("11/10/2026")` is 10 November in
        JavaScript and 11 October in this office. A PO silently booked a
        month out is a far worse outcome than a rejected row, so an
        ambiguous date is now REFUSED with a message naming the formats that
        work, rather than quietly interpreted.
*/

/* Accepted date inputs, in the order they are tried. A real Excel date cell
   is by far the best case — it carries no ambiguity at all — so the guide
   tells people to format the column as a Date and be done with it. */
export const DATE_FORMATS = [
  { label: "A real Excel date cell", example: "(formatted as Date in Excel)", note: "Best — no ambiguity at all" },
  { label: "YYYY-MM-DD", example: "2026-10-11", note: "Year first, always unambiguous" },
  { label: "DD-MMM-YYYY", example: "11-Oct-2026", note: "Month spelled, always unambiguous" },
  { label: "DD MMM YY", example: "11 Oct 26", note: "Month spelled" },
];

/* Refused on purpose, with the reason spelled out on screen. */
export const AMBIGUOUS_DATE_NOTE =
  "11/10/2026 is refused: it means 11 October here and 10 November to most software. " +
  "Use 2026-10-11 or 11-Oct-2026, or format the column as a Date in Excel.";

/* The columns, per source. `required` is the machine-readable half of the
   guide and is what the importer checks — one list, so the help text cannot
   promise something different from what the code enforces. */
export const FIELDS = [
  { key: "po_prefix", header: "PO Prefix", kind: "text",
    required: { plm: true, licensee: false },
    help: {
      plm: "The letters before the PO number — RT, PE.",
      licensee: "Leave BLANK. A licensee PO has no prefix; put the whole reference in PO #.",
    } },
  { key: "po_number", header: "PO #", kind: "text",
    required: { plm: true, licensee: true },
    help: {
      plm: "The number after the prefix — 5077.",
      licensee: "The licensee's whole PO reference, exactly as they wrote it — TP13-SP27 HATS.",
    } },
  { key: "style", header: "Style#", kind: "text",
    required: { plm: true, licensee: true },
    help: "The style number. One PO may hold several — one row per style and colour." },
  { key: "color_way", header: "Color Way", kind: "text",
    required: { plm: true, licensee: false },
    help: {
      plm: "Colour name, one row per colour.",
      licensee: "Colour name. Leave blank only if the order genuinely has no colour breakdown.",
    } },
  { key: "qty", header: "Ordered Quantity", kind: "number",
    required: { plm: true, licensee: true },
    help: "Pieces for this style and colour. A whole number above zero." },
  { key: "etd", header: "Latest Required X-Country Ship Date", kind: "date",
    required: { plm: false, licensee: false },
    help: "The delivery date. Applies to the whole PO — put the same date on every row of it." },
  { key: "po_issue_date", header: "PO Issue Date", kind: "date",
    required: { plm: false, licensee: false },
    help: "The date the licensee raised the PO. Optional." },
  { key: "unit_price", header: "Unit_Price", kind: "number",
    required: { plm: false, licensee: false },
    help: "FOB per piece for this STYLE. Optional — it can be set later on the Qty & Pricing tab." },
  { key: "customer", header: "Customer Name", kind: "text",
    required: { plm: false, licensee: false },
    help: "Matched to an existing customer by name. Unmatched imports anyway, with a note." },
  { key: "division", header: "Division", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional." },
  { key: "business_unit", header: "Business Unit", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional." },
  { key: "product_group", header: "Product Group", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional." },
  { key: "label", header: "Label", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional." },
  { key: "season", header: "Season", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional. Free text — SP2027." },
  { key: "fabric_ref", header: "Fabric Ref. #", kind: "text",
    required: { plm: false, licensee: false }, help: "Optional." },
  { key: "merchandiser", header: "Merchandiser", kind: "text",
    required: { plm: false, licensee: false },
    help: "Matched by full name. Applies to the whole PO." },
];

export function isRequired(field, source) {
  const r = field?.required;
  return typeof r === "object" ? !!r[source] : !!r;
}

export function helpFor(field, source) {
  const h = field?.help;
  return typeof h === "object" ? (h[source] || h.plm || "") : (h || "");
}

export function requiredKeys(source) {
  return FIELDS.filter(f => isRequired(f, source)).map(f => f.key);
}

export function fieldsFor(source) {
  /* PO Prefix is not shown to a licensee user at all — a column they are
     told to leave blank is a column that invites being filled in. It stays
     in the template so a file saved from the Main PLM still imports. */
  return FIELDS.filter(f => !(source === "licensee" && f.key === "po_prefix"));
}

export const __internals = { FIELDS };
