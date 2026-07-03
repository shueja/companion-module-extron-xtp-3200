# Module for Extron XTP II Crosspoint 3200

> this module connects via a telnet connection.

## Extra Information

* Ensure no password it set.
* Extron telnet connection has a timeout default 5mins

## Supported commands

* **Input to Output** Route an input to an output, choose between Audio & Video, Audio only, Video only
* **Input to all Outputs** Route an input to all outputs, choose between Audio & Video, Audio only, Video only
* **Recall Preset** Recall Global Preset

## Variables

* **route_iX_oY** Boolean route state for each input/output pair (for example, `route_i1_o1`)
* For each output, only one input variable is true at a time when routing feedback is received.

> This module is using Extron SIS commands.
