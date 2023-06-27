export DEBIAN_FRONTEND=noninteractive
# Install dependencies

apt update
apt install -yq nodejs pkg-config make g++ libsecret-1-dev libx11-dev libxkbfile-dev gcc
npm install -g yarn
/bin/bash ./setup.sh
/bin/bash ./build.sh

# install vscoqtop
apt install -yq opam build-essential
opam init -a
opam update
opam switch create 4.13.1
eval $(opam env --switch=4.13.1)
opam pin add coq-core.dev "https://github.com/coq/coq.git#51814505fdeb5bc9f11fc7bd95493f0e7397509f" -y
opam pin add coq-stdlib.dev "https://github.com/coq/coq.git#51814505fdeb5bc9f11fc7bd95493f0e7397509f" -y
opam pin add vscoq-language-server ./vscoq/language-server/ -y

rm -rf ./out
apt install -yq libatk1.0-0 libatk-bridge2.0-0 libcups2 libgtk-3-0 libgbm1 libasound2

# Run run.sh as new user

