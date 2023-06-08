nvm use 14
killall /home/jjy/.nvm/versions/node/v14.15.4/bin/node
rm -rf workdir/*
cd docker && docker-compose down && docker-compose up -d && cd ..
cd offchain-modules
yarn build && yarn integration-erc20 | tee ../integration.log
