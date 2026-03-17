/**
 * Script
 * Generate a terminalizer recording from a declarative YAML script file
 *
 * @author Idapixl / Fozikio
 */

var spawnSync = require('child_process').spawnSync;
var path = require('path');

/**
 * Default values for scene options
 */
var DEFAULTS = {
  prompt: '$ ',
  typingSpeed: 50,
  randomness: 20,
  postDelay: 500
};

/**
 * Return a random integer in the range [base - jitter, base + jitter], minimum 1
 *
 * @param  {Number} base
 * @param  {Number} jitterAmt
 * @return {Number}
 */
function withJitter(base, jitterAmt) {
  var offset = Math.floor(Math.random() * (jitterAmt * 2 + 1)) - jitterAmt;
  return Math.max(1, base + offset);
}

/**
 * Run a shell command and return combined stdout+stderr as a string.
 * Uses spawnSync with shell:true so the user's script commands work as expected.
 *
 * @param  {String} command  Shell command string (user-authored, trusted content)
 * @param  {String} cwd
 * @return {String}
 */
function runCommand(command, cwd) {

  // spawnSync with shell:true mirrors execSync behaviour but gives us explicit control
  var result = spawnSync(command, [], {
    shell: true,
    cwd: cwd || process.cwd(),
    encoding: 'utf8'
  });

  var out = result.stdout || '';
  var err = result.stderr || '';
  return out + (err ? err : '');

}

/**
 * Convert a scene array into terminalizer record frames
 *
 * @param  {Array}  scenes
 * @return {Array}  records
 */
function scenesToRecords(scenes) {

  var records = [];

  scenes.forEach(function(scene) {

    var type = scene.type;

    if (type === 'command') {

      var prompt    = scene.prompt      || DEFAULTS.prompt;
      var speed     = scene.typingSpeed || DEFAULTS.typingSpeed;
      var rand      = (scene.randomness !== undefined) ? scene.randomness : DEFAULTS.randomness;
      var postDelay = (scene.postDelay  !== undefined) ? scene.postDelay  : DEFAULTS.postDelay;
      var text      = scene.text || '';

      // Emit the prompt as a single frame
      records.push({ delay: 200, content: prompt });

      // Emit each character with realistic per-character timing
      for (var i = 0; i < text.length; i++) {
        records.push({ delay: withJitter(speed, rand), content: text[i] });
      }

      // Enter key frame followed by postDelay pause
      records.push({ delay: postDelay, content: '\r\n' });

    } else if (type === 'output') {

      var postDelay = (scene.postDelay !== undefined) ? scene.postDelay : 2000;
      var content   = (scene.content || '').replace(/\n/g, '\r\n');

      records.push({ delay: postDelay, content: content });

    } else if (type === 'run') {

      var postDelay = (scene.postDelay !== undefined) ? scene.postDelay : 3000;
      var output    = runCommand(scene.command, scene.cwd);
      var content   = output.replace(/\n/g, '\r\n');

      records.push({ delay: postDelay, content: content });

    } else if (type === 'wait') {

      var duration = scene.duration || 1000;
      records.push({ delay: duration, content: '' });

    } else if (type === 'clear') {

      // ANSI: move to home, clear visible screen, clear scrollback
      records.push({ delay: 100, content: '\x1b[H\x1b[2J\x1b[3J' });

    } else {

      console.warn('Unknown scene type: ' + type + ' — skipping');

    }

  });

  return records;

}

/**
 * Build the output YAML string in the same format as terminalizer recordings
 *
 * @param  {Object|String} configSection
 * @param  {Array}         records
 * @return {String}
 */
function buildOutputYAML(configSection, records) {

  var yaml = di.yaml;
  var output = '';

  output += '# The configurations that used for the recording, feel free to edit them\n';
  output += 'config:\n\n';

  var rawConfig = (typeof configSection === 'string')
    ? configSection
    : yaml.dump(configSection, { indent: 2 });

  // Indent two spaces to nest under config:
  output += rawConfig.replace(/^/gm, '  ');

  output += '\n# Records, feel free to edit them\n';
  output += yaml.dump({ records: records });

  return output;

}

/**
 * The command's main function
 *
 * @param {Object} argv
 */
function command(argv) {

  var scriptPath = argv.scriptFile;
  var scriptData;

  // Load and parse the script YAML
  try {
    var raw = di.fs.readFileSync(scriptPath, 'utf8');
    scriptData = di.yaml.load(raw);
  } catch (err) {
    return di.errorHandler(new Error('Failed to read script file: ' + err.message));
  }

  if (!scriptData || !Array.isArray(scriptData.scenes)) {
    return di.errorHandler(new Error('Script file must have a top-level "scenes" array'));
  }

  // Determine output path
  var outputPath = argv.output;
  if (!outputPath) {
    var base = path.basename(scriptPath, path.extname(scriptPath));
    outputPath = path.join(path.dirname(scriptPath), base + '-recording.yml');
  } else if (!path.extname(outputPath)) {
    outputPath = outputPath + '.yml';
  }

  // Merge script config with terminalizer defaults so all required fields exist
  var defaultConfig = di.utility.getDefaultConfig().json;
  var scriptConfig = scriptData.config || {};
  var mergedConfig = di.deepmerge(defaultConfig, scriptConfig);
  var configSection = mergedConfig;

  // Generate record frames from scenes
  var records = scenesToRecords(scriptData.scenes);

  // Build output YAML
  var outputYAML = buildOutputYAML(configSection, records);

  // Write the output file
  try {
    di.fs.writeFileSync(outputPath, outputYAML, 'utf8');
  } catch (err) {
    return di.errorHandler(new Error('Failed to write output file: ' + err.message));
  }

  console.log(di.chalk.green('Recording generated successfully'));
  console.log('Output file:      ' + di.chalk.magenta(outputPath));
  console.log('Frames generated: ' + di.chalk.cyan(String(records.length)));
  console.log('');
  console.log('Render it with:');
  console.log('  ' + di.chalk.magenta('terminalizer render ' + path.basename(outputPath, '.yml')));

}

////////////////////////////////////////////////////
// Command Definition //////////////////////////////
////////////////////////////////////////////////////

/**
 * Command's usage
 * @type {String}
 */
module.exports.command = 'script <scriptFile>';

/**
 * Command's description
 * @type {String}
 */
module.exports.describe = 'Generate a terminalizer recording from a declarative script file';

/**
 * Handler
 *
 * @param {Object} argv
 */
module.exports.handler = function(argv) {
  command(argv);
};

/**
 * Builder
 *
 * @param {Object} yargs
 */
module.exports.builder = function(yargs) {

  // Script file positional argument
  yargs.positional('scriptFile', {
    describe: 'Path to the script YAML file',
    type: 'string',
    coerce: function(val) {
      return di.path.resolve(val);
    }
  });

  // Output file option
  yargs.option('o', {
    alias: 'output',
    type: 'string',
    describe: 'Output recording file path (defaults to <scriptFile basename>-recording.yml)',
    requiresArg: true
  });

  // Config override option (reserved for future use — script config takes precedence)
  yargs.option('c', {
    alias: 'config',
    type: 'string',
    describe: 'Overwrite the default configurations',
    requiresArg: true
  });

  // Examples
  yargs.example('$0 script demo-script.yml', 'Generate a recording from demo-script.yml');
  yargs.example('$0 script demo-script.yml -o my-recording.yml', 'Specify the output file');

};
