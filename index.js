#!/usr/bin/env node

var Emitter = require('events').EventEmitter,
    forEach = require('async-foreach').forEach,
    chokidar = require('chokidar'),
    grapher = require('sass-graph'),
    meow = require('meow'),
    util = require('util'),
    path = require('path'),
    glob = require('glob'),
    render = require('node-sass').render,
    stdin = require('get-stdin'),
    fs = require('fs');

/**
 * Initialize CLI
 */

var cli = meow({
  version: process.sass.versionInfo,
  help: [
    'Usage',
    '  node-sass [options] <input.scss> [output.css]',
    '  cat <input.scss> | node-sass [options] > output.css',
    '',
    'Example',
    '  node-sass --output-style compressed foobar.scss foobar.css',
    '  cat foobar.scss | node-sass --output-style compressed > foobar.css',
    '',
    'Options',
    '  -w, --watch                Watch a directory or file',
    '  -r, --recursive            Recursively watch directories or files',
    '  -o, --output               Output directory',
    '  -x, --omit-source-map-url  Omit source map URL comment from output',
    '  -i, --indented-syntax      Treat data from stdin as sass code (versus scss)',
    '  -q, --quiet                Suppress log output except on error',
    '  -v, --version              Prints version info',
    '  --output-style             CSS output style (nested | expanded | compact | compressed)',
    '  --indent-type              Indent type for output CSS (space | tab)',
    '  --indent-width             Indent width; number of spaces or tabs (maximum value: 10)',
    '  --linefeed                 Linefeed style (cr | crlf | lf | lfcr)',
    '  --source-comments          Include debug info in output',
    '  --source-map               Emit source map',
    '  --source-map-contents      Embed include contents in map',
    '  --source-map-embed         Embed sourceMappingUrl as data URI',
    '  --source-map-root          Base path, will be emitted in source-map as is',
    '  --include-path             Path to look for imported files',
    '  --follow                   Follow symlinked directories',
    '  --precision                The amount of precision allowed in decimal numbers',
    '  --importer                 Path to .js file containing custom importer',
    '  --functions                Path to .js file containing custom functions',
    '  --help                     Print usage info'
  ].join('\n')
}, {
  boolean: [
    'indented-syntax',
    'follow',
    'omit-source-map-url',
    'quiet',
    'recursive',
    'source-map-embed',
    'source-map-contents',
    'source-comments',
    'watch'
  ],
  string: [
    'functions',
    'importer',
    'include-path',
    'indent-type',
    'linefeed',
    'output',
    'output-style',
    'precision',
    'source-map-root'
  ],
  alias: {
    c: 'source-comments',
    i: 'indented-syntax',
    q: 'quiet',
    o: 'output',
    r: 'recursive',
    x: 'omit-source-map-url',
    v: 'version',
    w: 'watch'
  },
  default: {
    'include-path': process.cwd(),
    'indent-type': 'space',
    'indent-width': 2,
    linefeed: 'lf',
    'output-style': 'nested',
    precision: 5,
    quiet: false,
    recursive: true
  }
});

/**
 * Is a Directory
 *
 * @param {String} filePath
 * @returns {Boolean}
 * @api private
 */

function isDirectory(filePath) {
  var isDir = false;
  try {
    var absolutePath = path.resolve(filePath);
    isDir = fs.lstatSync(absolutePath).isDirectory();
  } catch (e) {
    isDir = e.code === 'ENOENT';
  }
  return isDir;
}

/**
 * Get correct glob pattern
 *
 * @param {Object} options
 * @returns {String}
 * @api private
 */

function globPattern(options) {
  return options.recursive ? '**/*.{sass,scss}' : '*.{sass,scss}';
}

/**
 * Create emitter
 *
 * @api private
 */

function getEmitter() {
  var emitter = new Emitter();

  emitter.on('error', function(err) {
    console.error(err);
    if (!options.watch) {
      process.exit(1);
    }
  });

  emitter.on('warn', function(data) {
    if (!options.quiet) {
      console.warn(data);
    }
  });

  emitter.on('log', function(data) {
    console.log(data);
  });

  emitter.on('done', function() {
    if (!options.watch && !options.directory) {
      process.exit;
    }
  });

  return emitter;
}

/**
 * Construct options
 *
 * @param {Array} arguments
 * @param {Object} options
 * @api private
 */

function getOptions(args, options) {
  options.src = args[0];

  if (args[1]) {
    options.dest = path.resolve(args[1]);
  } else if (options.output) {
    options.dest = path.join(
      path.resolve(options.output),
      [path.basename(options.src, path.extname(options.src)), '.css'].join(''));  // replace ext.
  }

  if (options.directory) {
    var sassDir = path.resolve(options.directory);
    var file = path.relative(sassDir, args[0]);
    var cssDir = path.resolve(options.output);
    options.dest = path.join(cssDir, file).replace(path.extname(file), '.css');
  }

  if (options.sourceMap) {
    if(!options.sourceMapOriginal) {
      options.sourceMapOriginal = options.sourceMap;
    }

    // check if sourceMap path ends with .map to avoid isDirectory false-positive
    var sourceMapIsDirectory = options.sourceMapOriginal.indexOf('.map', options.sourceMapOriginal.length - 4) === -1 && isDirectory(options.sourceMapOriginal);

    if (options.sourceMapOriginal === 'true') {
      options.sourceMap = options.dest + '.map';
    } else if (!sourceMapIsDirectory) {
      options.sourceMap = path.resolve(options.sourceMapOriginal);
    } else if (sourceMapIsDirectory) {
      if (!options.directory) {
        options.sourceMap = path.resolve(options.sourceMapOriginal, path.basename(options.dest) + '.map');
      } else {
        var sassDir = path.resolve(options.directory);
        var file = path.relative(sassDir, args[0]);
        var mapDir = path.resolve(options.sourceMapOriginal);
        options.sourceMap = path.join(mapDir, file).replace(path.extname(file), '.css.map');
      }
    }
  }

  return options;
}

/**
 * Watch
 *
 * @param {Object} options
 * @param {Object} emitter
 * @api private
 */

function watch(options, emitter) {
  var paths = [];

  var graphOptions = { loadPaths: options.includePath, extensions: ['scss', 'sass', 'css'] };
  var graph;
  if (options.directory) {
    graph = grapher.parseDir(options.directory, graphOptions);
  } else {
    graph = grapher.parseFile(options.src, graphOptions);
  }

  // Add all files to watch list
  for (var i in graph.index) {
    paths.push(i);
  }

  var watcher = chokidar.watch(paths);
  watcher.on('error', emitter.emit.bind(emitter, 'error'));

  watcher.on('change', function(file) {
    var files = [file];
    graph.visitAncestors(file, function(parent) {
      files.push(parent);
    });
    files.forEach(function(file) {
      if (path.basename(file)[0] !== '_') {
        renderFile(file, options, emitter);
      }
    });
  });
}

/**
 * Run
 *
 * @param {Object} options
 * @param {Object} emitter
 * @api private
 */

function run(options, emitter) {
  if (!Array.isArray(options.includePath)) {
    options.includePath = [options.includePath];
  }

  if (options.directory) {
    if (!options.output) {
      emitter.emit('error', 'An output directory must be specified when compiling a directory');
    }
    if (!isDirectory(options.output)) {
      emitter.emit('error', 'An output directory must be specified when compiling a directory');
    }
  }

  if (options.sourceMapOriginal && options.directory && !isDirectory(options.sourceMapOriginal) && options.sourceMapOriginal !== 'true') {
    emitter.emit('error', 'The --source-map option must be either a boolean or directory when compiling a directory');
  }

  if (options.importer) {
    if ((path.resolve(options.importer) === path.normalize(options.importer).replace(/(.+)([\/|\\])$/, '$1'))) {
      options.importer = require(options.importer);
    } else {
      options.importer = require(path.resolve(options.importer));
    }
  }

  if (options.functions) {
    if ((path.resolve(options.functions) === path.normalize(options.functions).replace(/(.+)([\/|\\])$/, '$1'))) {
      options.functions = require(options.functions);
    } else {
      options.functions = require(path.resolve(options.functions));
    }
  }

  if (options.watch) {
    watch(options, emitter);
  } else if (options.directory) {
    renderDir(options, emitter);
  } else {
    render(options, emitter);
  }
}

/**
 * Render a file
 *
 * @param {String} file
 * @param {Object} options
 * @param {Object} emitter
 * @api private
 */
function renderFile(file, options, emitter) {
  options = getOptions([path.resolve(file)], options);
  if (options.watch) {
    emitter.emit('warn', util.format('=> changed: %s', file));
  }
  render(options, emitter);
}

/**
 * Render all sass files in a directory
 *
 * @param {Object} options
 * @param {Object} emitter
 * @api private
 */
function renderDir(options, emitter) {
  var globPath = path.resolve(options.directory, globPattern(options));
  glob(globPath, { ignore: '**/_*', follow: options.follow }, function(err, files) {
    if (err) {
      return emitter.emit('error', util.format('You do not have permission to access this path: %s.', err.path));
    } else if (!files.length) {
      return emitter.emit('error', 'No input file was found.');
    }

    forEach(files, function(subject) {
      emitter.once('done', this.async());
      renderFile(subject, options, emitter);
    }, function(successful, arr) {
      var outputDir = path.join(process.cwd(), options.output);
      emitter.emit('warn', util.format('Wrote %s CSS files to %s', arr.length, outputDir));
      process.exit;
    });
  });
}

/**
 * Arguments and options
 */

var options = getOptions(cli.input, cli.flags);
var emitter = getEmitter();

/**
 * Show usage if no arguments are supplied
 */

if (!options.src && process.stdin.isTTY) {
  emitter.emit('error', [
    'Provide a Sass file to render',
    '',
    '  Example',
    '    node-sass --output-style compressed foobar.scss foobar.css',
    '    cat foobar.scss | node-sass --output-style compressed > foobar.css'
  ].join('\n'));
}

/**
 * Apply arguments
 */

if (options.src) {
  if (isDirectory(options.src)) {
    options.directory = options.src;
  }
  run(options, emitter);
} else if (!process.stdin.isTTY) {
  stdin(function(data) {
    options.data = data;
    options.stdin = true;
    run(options, emitter);
  });
}

return emitter;
