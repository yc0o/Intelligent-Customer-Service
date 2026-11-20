pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
    timeout(time: 15, unit: 'MINUTES')
  }

  environment {
    PORT = '3000'
  }

  stages {
    stage('检出代码') {
      steps {
        checkout scm
        sh 'git log -1 --oneline'
      }
    }

    stage('环境与语法校验') {
      steps {
        sh '''
          set -e
          export PATH=/usr/local/bin:$PATH
          node -v
          major=$(node -p "process.versions.node.split('.')[0]")
          [ "$major" -ge 22 ] || { echo "需要 Node >= 22，当前为 $major"; exit 1; }
          node -e "require('node:sqlite'); require('node:http'); console.log('内置模块 OK')"
          for f in server.js $(find src scripts -name '*.js'); do node --check "$f"; done
          for f in public/assets/*.js; do node --check "$f"; done
          echo "语法检查通过"
        '''
      }
    }

    stage('部署到生产') {
      steps {
        // 部署动作统一收敛到服务器脚本：拉取 → 语法校验 → 重启 → 健康检查 → 失败回滚
        sh 'sudo -n /usr/local/bin/xigu-deploy.sh'
      }
    }

    stage('健康检查') {
      steps {
        sh '''
          set -e
          for i in $(seq 1 20); do
            if curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'; then
              echo "健康检查通过（第 $i 次探测）"
              exit 0
            fi
            sleep 1
          done
          echo "健康检查失败"
          sudo -n /usr/bin/systemctl status "$SERVICE" --no-pager || true
          exit 1
        '''
      }
    }
  }

  post {
    success {
      echo "部署成功：构建 #${BUILD_NUMBER}"
    }
    failure {
      echo "部署失败：构建 #${BUILD_NUMBER}，请查看上方日志"
    }
  }
}
