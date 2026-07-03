# Module for Extron XTP II Crosspoint 3200

> This module connects via a telnet connection.

## Extra Information

* Extron telnet connection has a default timeout around 5 minutes.
* Configure input and output counts in module settings to limit created route variables.
* Configure tie poll period (seconds) to periodically refresh input-output tie state (set to 0 to disable).
* Polling performs per-output tie queries for AV route status.
* Module enables SIS verbose mode 3 after login and parses tie/untie responses to keep variables updated.

## Supported commands

* **Input to Output** Route an input to an output, choose between Audio & Video, Audio only, Video only
* **Input to all Outputs** Route an input to all outputs, choose between Audio & Video, Audio only, Video only
* **Recall Preset** Recall Global Preset

## Variables

* **route_iX_oY** Boolean route state for each input/output pair (for example, `route_i1_o1`)
* For each output, only one input variable is true at a time when routing feedback is received.

> This module uses Extron SIS commands.
