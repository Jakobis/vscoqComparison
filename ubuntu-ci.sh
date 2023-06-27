export DEBIAN_FRONTEND=noninteractive
# add node source
curl -sL https://deb.nodesource.com/setup_18.x | sudo -E bash -
# Install dependencies
sudo sed -i 's/#$nrconf{restart} = '"'"'i'"'"';/$nrconf{restart} = '"'"'a'"'"';/g' /etc/needrestart/needrestart.conf
apt update
apt install -yq nodejs pkg-config make g++ libsecret-1-dev libx11-dev libxkbfile-dev gcc npm
apt install -yq libatk1.0-0 libatk-bridge2.0-0 libcups2 libgtk-3-0 libgbm1 libasound2
apt install -yq opam build-essential libgmp-dev

# Switch user here. todo
/bin/bash ./setup.sh
/bin/bash ./build.sh

# install vscoqtop
opam init -a
opam update
opam switch create 4.13.1
eval $(opam env --switch=4.13.1)
opam pin add coq-core.dev "https://github.com/coq/coq.git#51814505fdeb5bc9f11fc7bd95493f0e7397509f" -y
opam pin add coq-stdlib.dev "https://github.com/coq/coq.git#51814505fdeb5bc9f11fc7bd95493f0e7397509f" -y
opam pin add vscoq-language-server ./vscoq/language-server/ -y

rm -rf ./out

# Run run.sh as new user

export DISPLAY=192.168.0.5:0.0

