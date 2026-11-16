# Land obligations data

`TEMPLATE.csv` is the import layout the platform reads (`src/obligations.js`, `fromCsv`). The three rows in it are **invented examples** so the demo page has something to check a work order against. No real landowner, agreement or clause is in this repo.

To load real obligations, export them from the land system (Pandell or another) and map its columns to this layout. Pandell's real export layout has not been seen by the team: the mapping is a parameter, not a guess.

`commitment-table-format.txt` is an **illustrative** excerpt written in the shape of a public CER commitment tracking table. It exists to test extraction. It is not copied from any company's filing. For real practice documents, download a public table (Trans Mountain's condition 6 commitment tracking table is on its website) and paste its text into the W8 workflow.
