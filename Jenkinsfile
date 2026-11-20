pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timeout(time: 30, unit: 'MINUTES')
  }

  environment {
    APP_NAME    = 'intelligent-customer-service'
    PORT        = '3000'
    NODE_MIN    = '22.5'
    APP_DIR     = "${WORKSPACE}"
    PID_FILE    = "${WORKSPACE}/.app.pid"
    LOG_FILE    = "${WORKSPACE}/app.log"
  }

  tools {
    // 需在 Jenkins「全局工具配置」里建一个名为 node-22 的 NodeJS 安装项
    nodejs 'node-22'
  }

  stages {

    stage('检出代码') {
      steps {
        checkout scm
        sh 'git log -1 --oneline'
      }
    }

    stage('环境校验') {
      steps {
        sh '''
          set -e
          node -v
          npm -v
          node -e "
            const need = process.env.NODE_MIN.split('.').map(Number);
            const cur  = process.versions.node.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
              if (cur[i] > need[i]) break;
              if (cur[i] < need[i]) {
                console.error('Node 版本过低，需要 >=' + process.env.NODE_MIN);
                process.exit(1);
              }
            }
            console.log('Node 版本校验通过');
          "
          # 内置模块可用性检查（node:sqlite 需 Node 22.5+）
          node -e "require('node:sqlite'); require('node:http'); console.log('内置模块 OK')"
        '''
      }
    }

    stage('安装依赖') {
      steps {
        // 项目零第三方依赖：有 package-lock 才装，否则跳过
        sh '''
          set -e
          if [ -f package-lock.json ]; then
            npm ci --no-audit --no-fund || npm install --no-audit --no-fund
          else
            echo "无 lock 文件且零第三方依赖，跳过安装"
          fi
        '''
      }
    }

    stage('静态检查') {
      steps {
        sh '''
          set -e
          # 语法自检，避免明显语法错误进入部署
          for f in server.js $(find src -name '*.js' 2>/dev/null); do
            node --check "$f"
          done
          echo "语法检查通过"
        '''
      }
    }

    stage('冒烟测试') {
      steps {
        sh '''
          set -e
          # 端到端冒烟脚本，30 断言覆盖完整业务链路
          node scripts/smoke-test.js || node scripts/smoke.js || npm test
        '''
      }
    }

    stage('打包归档') {
      steps {
        sh '''
          set -e
          tar -czf ${APP_NAME}-${BUILD_NUMBER}.tgz \
            --exclude='node_modules' --exclude='.git' \
            src public scripts server.js package.json README.md
        '''
        archiveArtifacts artifacts: "${APP_NAME}-${BUILD_NUMBER}.tgz", fingerprint: true
      }
    }

    stage('部署到生产') {
      when { branch 'main' }
      steps {
        sh '''
          set -e
          # 停旧进程
          if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
            kill "$(cat $PID_FILE)"; sleep 2
          fi
          # 起新进程
          PORT=$PORT nohup node server.js > "$LOG_FILE" 2>&1 &
          echo $! > "$PID_FILE"
          sleep 3
        '''
      }
    }

    stage('健康检查') {
      when { branch 'main' }
      steps {
        sh '''
          set -e
          for i in $(seq 1 10); do
            code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ || echo 000)
            if [ "$code" = "200" ]; then
              echo "健康检查通过 (HTTP $code)"
              exit 0
            fi
            echo "第 $i 次探测失败 (HTTP $code)，重试..."; sleep 3
          done
          echo "健康检查失败"; tail -50 "$LOG_FILE"; exit 1
        '''
      }
    }
  }

  post {
    success {
      echo "✅ ${APP_NAME} 构建 #${BUILD_NUMBER} 成功"
    }
    failure {
      echo "❌ ${APP_NAME} 构建 #${BUILD_NUMBER} 失败，请查看日志"
    }
    always {
      // 清理工作区临时文件，保留归档包
      cleanWs(notFailBuild: true, deleteDirs: true, patterns: [[pattern: '**/node_modules/**', type: 'INCLUDE']])
    }
  }
}
