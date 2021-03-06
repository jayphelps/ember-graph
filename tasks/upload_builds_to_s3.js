'use strict';

var fs = require('fs');
var sh = require('execSync');
var AWS = require('aws-sdk');

module.exports = function(grunt) {
	grunt.registerTask('upload_builds_to_s3', function() {
		var done = this.async();
		var hash = sh.exec('git rev-parse HEAD').stdout.trim();
		var debugBuild = fs.readFileSync('./dist/ember-graph.js', { encoding: 'utf8' });
		var productionBuild = fs.readFileSync('./dist/ember-graph.prod.js', { encoding: 'utf8' });
		var minifiedBuild = fs.readFileSync('./dist/ember-graph.min.js', { encoding: 'utf8' });

		var count = 0;
		var counter = function(success, fileName) {
			count = count + 1;

			if (!success) {
				console.log('Error uploading file to S3: ' + fileName);
			}

			if (count >= 6) {
				done();
			}
		};

		var s3 = new AWS.S3();
		uploadFile(s3, 'ember-graph-latest.js', debugBuild, counter);
		uploadFile(s3, 'ember-graph-' + hash + '.js', debugBuild, counter);
		uploadFile(s3, 'ember-graph-latest.prod.js', productionBuild, counter);
		uploadFile(s3, 'ember-graph-' + hash + '.prod.js', productionBuild, counter);
		uploadFile(s3, 'ember-graph-latest.min.js', minifiedBuild, counter);
		uploadFile(s3, 'ember-graph-' + hash + '.min.js', minifiedBuild, counter);
	});
};

function uploadFile(s3, fileName, contents, callback) {
	s3.putObject({
		ACL: 'public-read',
		Body: contents,
		Bucket: 'ember-graph-builds',
		ContentType: 'application/javascript',
		Key: fileName
	}, function(err, data) {
		callback(!err, fileName);
	});
}