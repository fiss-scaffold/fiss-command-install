/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

exports.name = 'install';
exports.usage = '[options] <components...>';
exports.desc = 'install components';

var logger = require('./lib/logger');
var factory = require('./lib/remotes/factory.js');
var _ = require('./lib/util.js');
var fs = require('fs');
var path = require('path');
var exists = fs.existsSync;
var write = fs.writeFileSync;
var Promise = require('bluebird');
var semver = require('semver');
var del = require('del');
var jsonfile = require('jsonfile');

// 默认设置，如果没有component.json，则使用此默认设置
var defaults = {
  protocol: 'gitlab',
  gitlab: {
    'author': 'fecom-fe',
    'domain': 'http://gitlab.58corp.com/',
    'token': 'WjZVqBGLzKs6cBVjsWf-'
  }
};

exports.register = function(commander) {

  commander
  .option('-r, --root <path>', 'set project root')
  .option('-i, --ignore', 'ignore excluded path')
  .option('--verbose', 'enable verbose mode')
  .option('--download-gitlab-from-svn', 'you don\'t need this.')
  .action(function() {
    var args = [].slice.call(arguments);
    var options = args.pop();
    var settings = {
      ignore: !!options.ignore,
      root: options.root || '',
      downloadGitlabFromSvn: options.downloadGitlabFromSvn,
      components: args.concat()
    };

    // resolve project root.
    // 根据 fis-conf.js 所在目录来决定 root 是哪个目录。
    Promise.try(function() {
      var findup = require('findup');

      return new Promise(function(resolve, reject) {

        if (!settings.root) { // 如果未指定-r或者--root参数
          var fup = findup(process.cwd(), 'fis-conf.js');
          var dir = null;

          fup.on('found', function(found) {
            dir = found;
            fup.stop();
          });

          fup.on('error', reject);

          fup.on('end', function() {

            if (dir && dir !== process.cwd()) {
              fis.log.notice('Detect `fis-conf.js` is under `' + dir.green + '`. \nComponents will be installed under the folder too.');
            }

            settings.root = dir || process.cwd();
            resolve(settings.root);
          });
        } else { // 如果指定了-r或者--root参数
          resolve(path.resolve(settings.root));
        }

      });
    })

    // load fis-conf.js if exists.
    // 读取用户配置信息。
    .then(function() {
      var filepath = path.resolve(settings.root, 'fis-conf.js');

      if (exists(filepath)) {
        try {
          require(filepath);
        } catch (e) {
          // fis.log.warning('Load fis-conf.js failure with message ' + e.message);
        }
      }

      // 应用  fis-conf.js
      settings.componentsDir = path.join(settings.root,
        fis.config.get('component.dir') || '/components');
      settings.protocol = fis.config.get('component.protocol', 'github');
      settings.github = fis.config.get('component.github', {
        author: "fis-components"
      });
      settings.gitlab = fis.config.get('component.gitlab', {});
      settings.lights = fis.config.get('component.lights', {});
    })

    .then(function() {
      var roadmap = fis.config.get('roadmap.path', []);
      var good = false;
      var folder = path.basename(fis.config.get('component.dir') || '/components');

      if (fis.config.get('component.skipRoadmapCheck', false)) {
        return;
      }

      roadmap.every(function(item) {
        var reg = item.reg.toString();

        if (~reg.indexOf(folder) && item.isMod) {
          good = true;
          return false;
        }
        return true;
      });

      good || logger.warn('Please copy the following rule to you `roadmap.path`\n settings in `fis-conf.js`:\n' +
        '{\n' +
        '    reg: /^\\/' + folder + '\\/.*\\.js$/i,\n' +
        '    isMod: true,\n' +
        '    jswrapper: {\n' +
        '        type: \'amd\'\n' +
        '    }\n' +
        '}\n'
      );
    })

    // 读取 components.json 如果存在
    .then(function() {
      var components = settings.components;
      var path = require('path');
      var exists = require('fs').existsSync;
      var componentJson = path.join(settings.root, 'component.json');

      if (!exists(componentJson)) { // 如果不存在component.json，使用默认设置

        if(!components.length) {
          throw new Error('No component was specified!');
        }

        logger.warn('Missing `component.json`, will use default settings');
        return new Promise(function (resolve, reject) {
          var ret = {};
          ret.protocol = (settings.protocol = defaults.protocol);
          ret.github = _.mixin(settings.github, defaults.github);
          ret.gitlab = _.mixin(settings.gitlab, defaults.gitlab);
          ret.lights = _.mixin(settings.lights, defaults.lights);
          resolve(ret);
        });
      } else { // 如果存在component.json，读取component.json中的设置
        var config = Promise.promisify(require('./lib/config'));

        return config(componentJson)

        .then(function(ret) {

          []
          .push
            .apply(settings.components, ret.dependencies || []);

          []
          .push
            .apply(settings.components, ret.devDependencies || []);

          ret.dir && (settings.componentsDir = path.join(settings.root, ret.dir));
          settings.protocol = (ret.protocol ? ret.protocol :  defaults.protocol);
          _.mixin(settings.github, _.mixin(defaults.github, ret.github));
          _.mixin(settings.gitlab, _.mixin(defaults.gitlab, ret.gitlab));
          _.mixin(settings.lights, _.mixin(defaults.lights, ret.lights));

        });
      }
    })

    .then(function() {
      var components = settings.components || [];

      factory.setSettings(settings);

      // validate and filter invalid dependencies.
      // 过滤掉不能识别的依赖。
      return strToRemote(components, false, settings);
    })

    // finally get components list.
    .then(function(components) {
      if (!components.length) {
        logger.warn('Installed nothing!');
        return;
      }

      var collector = require('./lib/collector.js');
      var SimpleTick = require('./lib/tick.js');
      var bar = new SimpleTick('analyzing dependencies ', {
        keepAlive: true
      });
      var specified = {};
      components.forEach(function(item) {
        specified[item.name] = item._version;
      });

      return collector(components)
      .then(function(components) {
        bar.clear();
        bar = null;
        return components;
      })

      .then(function(components) {
        // console.log(components);
        var finalList = [];
        var posMap = {};
        var alerted = {};
        var notified = {};

        components.forEach(function(item) {
          if (typeof posMap[item.name] !== 'undefined') {
            var target = finalList[posMap[item.name]];
            var finalItem = target;

            // 版本一致直接跳过。
            if (target.version === item.version) {
              return;
            }

            // 原有版本不符合制定版本要求，而先版本符合，那就直接替换吧。
            if (specified[item.name] && !satisfies(target.version, specified[item.name]) && satisfies(item.version, specified[item.name])) {
              finalItem = item;
              finalList.splice(posMap[item.name], 1, item);
              return;
            }

            // 现有版本不符合制定要求，那还是不要换了。
            if (specified[item.name] && !satisfies(item.version, specified[item.name])) {
              !notified[item.name + '@' + item.version] && fis.log.warning(item.name + '@' + item.version + ' don\'t satisfy the version ' + item.name + '@' + specified[item.name] + ' you specified. The version ' + finalItem.name + '@' + finalItem.version + ' will be keeped!');
              notified[item.name + '@' + item.version] = true;
              return;
            }

            // 用户没有指定要什么版本，那就用最新的版本
            // 不满足需求，那就在入口指定版本吧。
            if (semver.valid(item.version) && semver.validRange(target.version) && semver.gt(item.version, target.version)) {
              finalItem = item;
              finalList.splice(posMap[item.name], 1, item);
            }

            if (!alerted[item.name + '@' + item.version]) {
              fis.log.warning(item.name + '@' + item.version + ' conflict againest with ' + target.name + '@' + target.version + ', version ' + finalItem.name + '@' + finalItem.version + ' will be used!');
              alerted[item.name + '@' + item.version] = true;
            }
          } else {
            posMap[item.name] = finalList.length;
            finalList.push(item);
          }
        });

        // console.log(finalList.map(function(item) {
        //   return item.name + '@' + item.version
        // }));

        // 过滤掉本地的。
        components = finalList.filter(function(item) {
          return item.location !== 'local';
        });

        if (!components.length) {
          console.log('Already installed');
          return components;
        }

        return Promise

          .reduce(components, function(collection, component) {
          var SimpleTick = require('./lib/tick.js');
          var ProgressBar = require('progress');

          var bar;
          var progress = function(percent, loaded, total) {
            if (total && process.stderr.isTTY) {
              bar = bar || new ProgressBar('downloading `' + component.address + '` [:bar] :percent :etas', {
                complete: '=',
                incomplete: ' ',
                width: 20,
                total: total,
                clear: true
              });

              bar.update(percent);
            } else {

              bar = bar || new SimpleTick('downloading `' + component.address + '` ');
              bar.tick();
            }
          };

          return component

            .install(progress)

            .then(function(component) {
              if (bar instanceof SimpleTick) {
                bar.clear();
              }
              collection.push(component);
              return collection;
            });

            // .catch(function(e) {
            //   logger.error('\x1b[31m%s\x1b[0m', e.message);
            //   fis.log.debug(e.stack);
            // });
        }, [])

        .then(function(components) {

          var last = components.length - 1;
          var arrs = components.map(function(item, index) {
            return (index === last ? '└── ' : '├── ') + item.type + ':' + item.address + '@' + item.version;
          });

          console.log('\nInstalled\n%s', arrs.join('\n'));
          return components;
        });
      })

      .catch(function(e) {
        bar && bar.clear;
        console.log('\x1b[31m%s\x1b[0m', e.message);
        logger.debug(e.stack);

        process.exit(1);
      });
    })

    // 保存 components.json
    .then(function(installed) {
      // 把安装的组件和版本号写入component.json中
      if (installed && installed.length) {
        var config = settings.config || {};
        var specified = strToRemote(args.concat(), false, settings);

        config.dependencies = config.dependencies || [];

        var oldList = strToRemote(config.dependencies, false, settings);

        specified.forEach(function(item) {
          var idx;

          if (!~_.indexOfArray('name', item.name, oldList) && ~(idx = _.indexOfArray('name', item.name, installed))) {

            var found = installed[idx];

            config.dependencies.push(found.type + ':' + found.address + '@' + found.version);
          }
        });

        var componentJson = path.join(settings.root, 'component.json');
        // 将安装的组件名称以及版本号写入component.json
        if(fs.existsSync(componentJson)) {
          var json = jsonfile.readFileSync(componentJson);
          json.dependencies || (json.dependencies = []);
          json.dependencies = json.dependencies.concat(config.dependencies).sort();
          jsonfile.writeFileSync(componentJson, json, { spaces: 2 });
        }

      }

      return installed;
    })
    .then(function (installed) {
      var promises = [];
      // 如果设置了-i选择，则不应用exclude配置项
      if(settings.ignore) return;
      // 遍历本次所有安装的组件
      installed.forEach(function (component) {
        var componentDir = path.join(settings.componentsDir, component.name); // 某个组件目录

        if(!component.config.exclude) return;

        promises.push(del(component.config.exclude.map(function (excludePath) {
          return path.join(componentDir, excludePath);
        })));

      });

      return Promise.all(promises);
    })

    // error handle
    .catch(function(e) {
      if (/Not\s+Found/i.test(e.message)) {
        logger.warn('`fis install` now is for installing commponents, you may use `\x1b[31mlights install\x1b[0m` instead.');
      }

      console.log('\x1b[31m%s\x1b[0m', e.message);
      // 添加调试信息
      if(process.env.NODE_ENV === 'debug') logger.error(e.stack);

    });
  });
};

function strToRemote(components, ignoreInvalid, settings) {
  return components

    .map(function(component) {
      var type = factory.detect(component);

      if (!type) {
        ignoreInvalid || logger.warn('`%s` is not a valid repository.', component);
        return null;
      }

      return factory(component, null, {
        downloadGitlabFromSvn: settings.downloadGitlabFromSvn
      });
    })
    .filter(function(item) {
      return item !== null;
    });
}

function satisfies(version, range) {
  if (range === '*') {
    return true;
  }

  return semver.valid(version) && semver.validRange(range) && semver.satisfies(version, range);
}
