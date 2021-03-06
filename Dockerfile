FROM fedora:25
RUN dnf -y upgrade
RUN curl --silent --location https://rpm.nodesource.com/setup_7.x | bash -
RUN dnf -y install nodejs
RUN dnf -y clean all
ADD config.js endpoint.js feeder.js helpers.js index.js log.js package.json /opt/feeder/
ADD config/default.yaml /opt/feeder/config/

WORKDIR /opt/feeder
RUN npm install

EXPOSE 8000

CMD ["/usr/bin/node", "index.js"]
