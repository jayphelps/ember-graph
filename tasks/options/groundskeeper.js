module.exports = {
	compile: {
		files: {
			'ember-graph.prod.js': 'ember-graph.js'
		},

		options: {
			console: false,
			debugger: false,
			namespace: ['Eg.debug']
		}
	}
};