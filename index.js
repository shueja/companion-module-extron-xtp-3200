const net = require('net')
const { runEntrypoint, InstanceBase, Regex, combineRgb, InstanceStatus } = require('@companion-module/base')

const XTP_MAX_INPUTS = 32
const XTP_MAX_OUTPUTS = 32
const DEFAULT_TIE_POLL_PERIOD_SECONDS = 120
const MIN_TIE_POLL_PERIOD_SECONDS = 120
const VERBOSE_MODE_COMMAND = 'W3CV|'
const DEFAULT_TIE_STATUS_QUERY_SUFFIX = '&'
const FEEDBACK_TIE_EXISTS = 'tie_exists'
const ENABLE_TIE_POLLING = true

class ExtronXtpInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.socket = undefined
		this.login = false
		this.heartbeatInterval = undefined
		this.tiePollInterval = undefined
		this.receiveBuffer = ''
		this.routeVariablesInitialized = false
		this.outputRouteState = {}
		this.verboseModeSet = false
		this.lastVerboseModeRequest = 0
		this.pendingTieResponseLog = undefined
		this.nextTiePollOutput = 1

		this.CHOICES_TYPE = [
			{ label: 'Audio & Video', id: '!' },
			{ label: 'Video only', id: '%' },
			{ label: 'Audio only', id: '$' },
		]
	}

	async init(config) {
		this.config = config
		this.initRouteVariables()
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.initTelnet()
	}

	async destroy() {
		this.stopHeartbeat()
		this.stopTieStatePoll()
		this.destroySocket()
	}

	async configUpdated(config) {
		const previousConfig = this.config || {}
		this.config = config
		this.initRouteVariables()
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()

		const networkSettingsChanged =
			previousConfig.host !== config.host || previousConfig.password !== config.password
		if (networkSettingsChanged) {
			this.initTelnet()
		}
	}

	getClampedCount(value, maxCount) {
		const count = Number.parseInt(value, 10)
		if (!Number.isInteger(count) || count < 1) {
			return maxCount
		}
		return Math.min(count, maxCount)
	}

	getConfiguredInputCount() {
		return this.getClampedCount(this.config?.input_count, XTP_MAX_INPUTS)
	}

	getConfiguredOutputCount() {
		return this.getClampedCount(this.config?.output_count, XTP_MAX_OUTPUTS)
	}

	getConfiguredTiePollPeriodSeconds() {
		const period = Number.parseInt(this.config?.tie_poll_period_seconds, 10)
		if (!Number.isInteger(period) || period < 0) {
			return DEFAULT_TIE_POLL_PERIOD_SECONDS
		}
		return period
	}

	getTieStatusQueryCommand(output) {
		// SIS "View RGBHV output tie" query: #&
		return `${output}${DEFAULT_TIE_STATUS_QUERY_SUFFIX}`
	}

	buildInputNameVariableId(input) {
		return `input_name_i${input}`
	}

	buildOutputNameVariableId(output) {
		return `output_name_o${output}`
	}

	getConfiguredInputName(input) {
		const rawName = this.config?.[`input_name_${input}`]
		const name = typeof rawName === 'string' ? rawName.trim() : ''
		if (name.length > 0) {
			return name
		}
		return `Input ${input}`
	}

	getConfiguredOutputName(output) {
		const rawName = this.config?.[`output_name_${output}`]
		const name = typeof rawName === 'string' ? rawName.trim() : ''
		if (name.length > 0) {
			return name
		}
		return `Output ${output}`
	}

	getInputChoices() {
		const choices = []
		const maxInputs = this.getConfiguredInputCount()
		for (let input = 1; input <= maxInputs; input++) {
			choices.push({
				id: `${input}`,
				label: `${input}: ${this.getConfiguredInputName(input)}`,
			})
		}
		return choices
	}

	getOutputChoices() {
		const choices = []
		const maxOutputs = this.getConfiguredOutputCount()
		for (let output = 1; output <= maxOutputs; output++) {
			choices.push({
				id: `${output}`,
				label: `${output}: ${this.getConfiguredOutputName(output)}`,
			})
		}
		return choices
	}

	getConfigFields() {
		const fields = [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This will establish a telnet connection to the XTP',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'XTP IP address',
				width: 12,
				default: '192.168.254.254',
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Admin or User Password',
				width: 8,
			},
			{
				type: 'textinput',
				id: 'input_count',
				label: 'Number of inputs (1-32)',
				width: 6,
				default: `${XTP_MAX_INPUTS}`,
				regex: Regex.NUMBER,
			},
			{
				type: 'textinput',
				id: 'output_count',
				label: 'Number of outputs (1-32)',
				width: 6,
				default: `${XTP_MAX_OUTPUTS}`,
				regex: Regex.NUMBER,
			},
			{
				type: 'textinput',
				id: 'tie_poll_period_seconds',
				label: 'Tie poll period in seconds (0 disables)',
				width: 6,
				default: `${DEFAULT_TIE_POLL_PERIOD_SECONDS}`,
				regex: Regex.NUMBER,
			},
		]

		const configuredInputs = this.getConfiguredInputCount()
		for (let input = 1; input <= configuredInputs; input++) {
			fields.push({
				type: 'textinput',
				id: `input_name_${input}`,
				label: `Input ${input} name`,
				width: 6,
				default: `Input ${input}`,
			})
		}

		const configuredOutputs = this.getConfiguredOutputCount()
		for (let output = 1; output <= configuredOutputs; output++) {
			fields.push({
				type: 'textinput',
				id: `output_name_${output}`,
				label: `Output ${output} name`,
				width: 6,
				default: `Output ${output}`,
			})
		}

		return fields
	}

	updateActions() {
		const inputChoices = this.getInputChoices()
		const routeInputChoices = [{ id: '0', label: '0: None' }, ...inputChoices]
		const outputChoices = this.getOutputChoices()

		const actions = {
			route: {
				name: 'Route input to output',
				options: [
					{
						type: 'dropdown',
						label: 'Input',
						id: 'input',
						choices: routeInputChoices,
						default: inputChoices[0]?.id || '1',
					},
					{
						type: 'dropdown',
						label: 'Output',
						id: 'output',
						choices: outputChoices,
						default: outputChoices[0]?.id || '1',
					},
					{
						type: 'dropdown',
						label: 'Type',
						id: 'type',
						choices: this.CHOICES_TYPE,
						default: '!',
					},
				],
				callback: async (action) => {
					const input = Number(action.options.input)
					const output = Number(action.options.output)
					const type = action.options.type || '!'
					if (!Number.isInteger(input) || !Number.isInteger(output)) return
					const command = `${input}*${output}${type}`
					this.log('info', `Routing command sent: input ${input} -> output ${output} (${type}), SIS: ${command}`)
					this.sendCommand(command)
				},
			},
		}

		this.setActionDefinitions(actions)
	}

	updateFeedbacks() {
		const inputChoices = this.getInputChoices()
		const outputChoices = this.getOutputChoices()

		const feedbacks = {}
		feedbacks[FEEDBACK_TIE_EXISTS] = {
			type: 'boolean',
			name: 'Tie exists (named input to named output)',
			description: 'Change button background when the selected input is routed to the selected output',
			defaultStyle: {
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 128, 0),
			},
			options: [
				{
					type: 'dropdown',
					label: 'Input',
					id: 'input',
					choices: inputChoices,
					default: inputChoices[0]?.id || '1',
				},
				{
					type: 'dropdown',
					label: 'Output',
					id: 'output',
					choices: outputChoices,
					default: outputChoices[0]?.id || '1',
				},
			],
			callback: (feedback) => {
				const input = Number(feedback.options.input)
				const output = Number(feedback.options.output)
				if (!Number.isInteger(input) || !Number.isInteger(output)) {
					return false
				}
				return this.outputRouteState[output] === input
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	updatePresets() {
		const presets = {
			route: {
				type: 'button',
				category: 'Route',
				name: 'Input to output',
				style: {
					text: 'Route',
					size: '18',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 0),
				},
				steps: [
					{
						down: [
							{
								actionId: 'route',
								options: {
									input: '1',
									output: '1',
									type: '!',
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			},
		}

		this.setPresetDefinitions(presets)
	}

	buildRouteVariableId(input, output) {
		return `route_i${input}_o${output}`
	}

	initRouteVariables() {
		const variableDefinitions = []
		const variableDefaults = {}
		const maxInputs = this.getConfiguredInputCount()
		const maxOutputs = this.getConfiguredOutputCount()

		for (let input = 1; input <= maxInputs; input++) {
			const inputNameVariableId = this.buildInputNameVariableId(input)
			variableDefinitions.push({
				name: `Configured name for Input ${input}`,
				variableId: inputNameVariableId,
			})
			variableDefaults[inputNameVariableId] = this.getConfiguredInputName(input)
		}

		for (let output = 1; output <= maxOutputs; output++) {
			const outputNameVariableId = this.buildOutputNameVariableId(output)
			variableDefinitions.push({
				name: `Configured name for Output ${output}`,
				variableId: outputNameVariableId,
			})
			variableDefaults[outputNameVariableId] = this.getConfiguredOutputName(output)
		}

		for (let input = 1; input <= maxInputs; input++) {
			for (let output = 1; output <= maxOutputs; output++) {
				const variableId = this.buildRouteVariableId(input, output)
				variableDefinitions.push({
					name: `Input ${input} routed to Output ${output}`,
					variableId,
				})
				variableDefaults[variableId] = false
			}
		}

		this.setVariableDefinitions(variableDefinitions)
		this.setVariableValues(variableDefaults)
		this.routeVariablesInitialized = true
	}

	setOutputRoute(output, input) {
		if (this.routeVariablesInitialized !== true) {
			return
		}

		const maxInputs = this.getConfiguredInputCount()
		const maxOutputs = this.getConfiguredOutputCount()

		if (output < 1 || output > maxOutputs || input < 0 || input > maxInputs) {
			return
		}

		const updatedValues = {}
		for (let sourceInput = 1; sourceInput <= maxInputs; sourceInput++) {
			updatedValues[this.buildRouteVariableId(sourceInput, output)] = input > 0 && sourceInput === input
		}
		this.setVariableValues(updatedValues)

		if (input > 0) {
			this.outputRouteState[output] = input
		} else {
			delete this.outputRouteState[output]
		}
		this.checkFeedbacks(FEEDBACK_TIE_EXISTS)
	}

	setAllOutputsRoute(input) {
		const maxInputs = this.getConfiguredInputCount()
		const maxOutputs = this.getConfiguredOutputCount()

		if (input < 0 || input > maxInputs) {
			return
		}
		for (let output = 1; output <= maxOutputs; output++) {
			this.setOutputRoute(output, input)
		}
	}

	enableVerboseMode() {
		if (this.login !== true || this.verboseModeSet === true) {
			return
		}

		const now = Date.now()
		if (now - this.lastVerboseModeRequest >= 5000) {
			this.sendCommand(VERBOSE_MODE_COMMAND)
			this.lastVerboseModeRequest = now
		}
	}

	handleVerboseModeFeedback(line) {
		const verboseMatch = line.match(/(?:^|\b)Vrb\s*([0-3])(?:\b|\])/i)
		if (!verboseMatch) {
			return false
		}

		const mode = parseInt(verboseMatch[1], 10)
		this.verboseModeSet = mode === 3
		if (!this.verboseModeSet) {
			this.log('warn', `Verbose mode response was ${mode}, retrying mode 3 request`)
			this.enableVerboseMode()
		}

		return true
	}

	logRawTieResponse(data) {
		if (!this.pendingTieResponseLog) {
			return
		}

		if (Date.now() > this.pendingTieResponseLog.expiresAt) {
			this.pendingTieResponseLog = undefined
			return
		}

		if (this.pendingTieResponseLog.logged === true) {
			return
		}

		const rawLine = String(data)
		if (rawLine.length === 0) {
			return
		}

		this.log('info', `Tie raw response received after command ${this.pendingTieResponseLog.command}: ${rawLine}`)
		this.pendingTieResponseLog.logged = true
	}

	processFeedbackLine(line) {
		if (this.handleVerboseModeFeedback(line)) {
			return
		}

		if (this.verboseModeSet !== true && /^\d{1,2}(?:\D+\d{1,2})*\]?$/i.test(line.trim())) {
			this.enableVerboseMode()
			return
		}

		const outputRouteMatch = line.match(
			/(?:Out|Output)\s*0*(\d+)[\s,;:|>\-\]\[•]*(?:In|Input)\s*0*(\d+)(?:[\s,;:|>\-\]\[•]*(?:All|Audio|Video|Aud|Vid|RGB))?/i,
		)
		if (outputRouteMatch) {
			const output = parseInt(outputRouteMatch[1], 10)
			const input = parseInt(outputRouteMatch[2], 10)
			this.setOutputRoute(output, input)
			return
		}

		const allOutputsRouteMatch = line.match(
			/(?:In|Input)\s*0*(\d+)[\s,;:|>\-\]\[•]*(?:All|Outputs?)/i,
		)
		if (allOutputsRouteMatch) {
			const input = parseInt(allOutputsRouteMatch[1], 10)
			this.setAllOutputsRoute(input)
		}
	}

	processFeedbackData(text) {
		const lines = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)

		for (const line of lines) {
			this.processFeedbackLine(line)
		}
	}

	handleTelnetData(buffer) {
		let out = []

		for (let i = 0; i < buffer.length; i++) {
			const byte = buffer[i]
			if (byte !== 255) {
				out.push(byte)
				continue
			}

			if (i + 1 >= buffer.length) break
			const command = buffer[++i]

			if (command === 255) {
				out.push(255)
				continue
			}

			if (i + 1 >= buffer.length) break
			const option = buffer[++i]

			if (command === 253) {
				this.socket?.write(Buffer.from([255, 252, option]))
			} else if (command === 251) {
				this.socket?.write(Buffer.from([255, 254, option]))
			}
		}

		if (out.length === 0) return ''
		return Buffer.from(out).toString('utf8')
	}

	incomingData(data) {
		if (this.login === false && data.match(/Extron Electronics/)) {
			this.updateStatus(InstanceStatus.Connecting, 'Logging in')
			this.sendCommand('I')
		}

		if (this.login === false && data.match(/Password:/)) {
			this.updateStatus(InstanceStatus.Connecting, 'Logging in')
			this.sendCommand(this.config.password || '')
		} else if (this.login === false && data.match(/Login/)) {
			this.login = true
			this.updateStatus(InstanceStatus.Ok)
			this.enableVerboseMode()
		} else if (this.login === false && data.match(/V|60-/)) {
			this.login = true
			this.updateStatus(InstanceStatus.Ok)
			this.enableVerboseMode()
		}
		else {
			this.logRawTieResponse(data)
			this.processFeedbackData(data)
		}

		if (this.login === true) {
			if (this.heartbeatInterval === undefined) {
				this.startHeartbeat()
			}

			if (this.tiePollInterval === undefined) {
				this.startTieStatePoll()
			}
		}
	}

	startHeartbeat() {
		if (this.heartbeatInterval !== undefined) {
			return
		}

		this.heartbeatInterval = setInterval(() => {
			this.login = false
			this.updateStatus(InstanceStatus.Connecting, 'Checking connection')
			this.sendCommand('N')
		}, 60 * 1000)
	}

	stopHeartbeat() {
		if (this.heartbeatInterval !== undefined) {
			clearInterval(this.heartbeatInterval)
			this.heartbeatInterval = undefined
		}
	}

	startTieStatePoll() {
		if (this.tiePollInterval !== undefined) {
			return
		}

		if (!ENABLE_TIE_POLLING) {
			return
		}

		const pollPeriodSeconds = Math.max(this.getConfiguredTiePollPeriodSeconds(), MIN_TIE_POLL_PERIOD_SECONDS)
		if (pollPeriodSeconds <= 0) {
			return
		}

		this.tiePollInterval = setInterval(() => {
			if (this.login === true) {
				this.pollTieStateNow()
			}
		}, pollPeriodSeconds * 1000)

		if (this.login === true) {
			this.pollTieStateNow()
		}
	}

	pollTieStateNow() {
		if (!ENABLE_TIE_POLLING) {
			return
		}

		const maxOutputs = this.getConfiguredOutputCount()
		if (maxOutputs < 1) {
			return
		}

		if (!Number.isInteger(this.nextTiePollOutput) || this.nextTiePollOutput < 1 || this.nextTiePollOutput > maxOutputs) {
			this.nextTiePollOutput = 1
		}

		const output = this.nextTiePollOutput
		this.sendCommand(this.getTieStatusQueryCommand(output))

		this.nextTiePollOutput += 1
		if (this.nextTiePollOutput > maxOutputs) {
			this.nextTiePollOutput = 1
		}
	}

	stopTieStatePoll() {
		if (this.tiePollInterval !== undefined) {
			clearInterval(this.tiePollInterval)
			this.tiePollInterval = undefined
		}
	}

	destroySocket() {
		if (this.socket) {
			this.socket.destroy()
			this.socket = undefined
		}
	}

	initTelnet() {
		this.stopHeartbeat()
		this.stopTieStatePoll()
		this.destroySocket()
		this.login = false
		this.verboseModeSet = false
		this.lastVerboseModeRequest = 0
		this.pendingTieResponseLog = undefined
		this.nextTiePollOutput = 1
		this.outputRouteState = {}
		this.receiveBuffer = ''

		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing host')
			return
		}

		this.socket = new net.Socket()

		this.socket.on('error', (err) => {
			this.log('error', `Network error: ${err.message}`)
			this.login = false
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})

		this.socket.on('close', () => {
			this.login = false
			this.updateStatus(InstanceStatus.Disconnected)
		})

		this.socket.on('connect', () => {
			this.login = false
			this.updateStatus(InstanceStatus.Connecting, 'Connected')
		})

		this.socket.on('data', (buffer) => {
			const clean = this.handleTelnetData(buffer)
			if (clean.length === 0) return

			this.receiveBuffer += clean
			const parts = this.receiveBuffer.split(/\r?\n/)
			this.receiveBuffer = parts.pop() || ''
			for (const line of parts) {
				if (line.length > 0) this.incomingData(line)
			}
		})

		this.socket.connect(23, this.config.host)
	}

	sendCommand(command) {
		if (!this.socket || this.socket.destroyed) {
			this.log('warn', 'Socket not connected')
			return
		}

		this.log('debug', `Sending command: ${command}`)

		if (/^\d+\*\d+[!%$]$/.test(command) || /^\d+\*[!%$]$/.test(command)) {
			this.pendingTieResponseLog = {
				command,
				expiresAt: Date.now() + 5000,
				logged: false,
			}
		}

		this.socket.write(`${command}\n`)
	}
}

runEntrypoint(ExtronXtpInstance)
